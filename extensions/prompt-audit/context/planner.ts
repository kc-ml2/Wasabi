import type {
  ContextAudience,
  ContextCapability,
  ContextGovernance,
  ContextOmission,
  ContextSection,
  ContextSource,
  EngineContextProfile,
  MaterializedContextBundle,
  RequirementStrength,
} from "./capabilities.ts";

interface MergedRequirement {
  capability: ContextCapability;
  audience: ContextAudience;
  strength: RequirementStrength;
  preferredRepresentations: string[];
  maxTokens?: number;
  requestedBy: string[];
}

class LatencyBudgetExceeded extends Error {}

async function materializeWithin(
  source: ContextSource,
  representation: string,
  maxTokens: number,
  timeoutMs: number,
) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      source.materialize(representation, maxTokens),
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new LatencyBudgetExceeded()), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

const strengthRank: Record<RequirementStrength, number> = {
  required: 0,
  preferred: 1,
  optional: 2,
};

function mergeRequirements(profiles: EngineContextProfile[]): MergedRequirement[] {
  const perAudience = new Map<string, MergedRequirement>();

  for (const profile of profiles) {
    for (const requirement of profile.requirements) {
      const audiences: Array<"audit" | "policy"> =
        requirement.audience === "both" ? ["audit", "policy"] : [requirement.audience];
      for (const audience of audiences) {
        const key = `${requirement.capability}:${audience}`;
        const existing = perAudience.get(key);
        if (!existing) {
          perAudience.set(key, {
            capability: requirement.capability,
            audience,
            strength: requirement.strength,
            preferredRepresentations: [...(requirement.preferredRepresentations ?? [])],
            maxTokens: requirement.maxTokens,
            requestedBy: [profile.id],
          });
          continue;
        }

        if (strengthRank[requirement.strength] < strengthRank[existing.strength]) {
          existing.strength = requirement.strength;
        }
        for (const representation of requirement.preferredRepresentations ?? []) {
          if (!existing.preferredRepresentations.includes(representation)) {
            existing.preferredRepresentations.push(representation);
          }
        }
        if (requirement.maxTokens !== undefined) {
          existing.maxTokens =
            existing.maxTokens === undefined
              ? requirement.maxTokens
              : Math.min(existing.maxTokens, requirement.maxTokens);
        }
        if (!existing.requestedBy.includes(profile.id)) existing.requestedBy.push(profile.id);
      }
    }
  }

  const result: MergedRequirement[] = [];
  const capabilities = new Set([...perAudience.values()].map((item) => item.capability));
  for (const capability of capabilities) {
    const audit = perAudience.get(`${capability}:audit`);
    const policy = perAudience.get(`${capability}:policy`);
    const canShare =
      audit &&
      policy &&
      audit.strength === policy.strength &&
      audit.maxTokens === policy.maxTokens &&
      JSON.stringify(audit.preferredRepresentations) ===
        JSON.stringify(policy.preferredRepresentations);
    if (canShare) {
      result.push({
        ...audit,
        audience: "both",
        requestedBy: [...new Set([...audit.requestedBy, ...policy.requestedBy])],
      });
    } else {
      if (audit) result.push(audit);
      if (policy) result.push(policy);
    }
  }

  return result.sort(
    (left, right) => strengthRank[left.strength] - strengthRank[right.strength],
  );
}

function omission(
  requirement: MergedRequirement,
  reason: ContextOmission["reason"],
): ContextOmission {
  return {
    capability: requirement.capability,
    audience: requirement.audience,
    requestedBy: requirement.requestedBy,
    strength: requirement.strength,
    reason,
  };
}

function appliesToAudience(sectionAudience: ContextAudience, audience: "audit" | "policy"): boolean {
  return sectionAudience === "both" || sectionAudience === audience;
}

export interface ContextPlanInput {
  auditProfile: EngineContextProfile;
  policyProfile: EngineContextProfile;
  sources: ContextSource[];
  governance: ContextGovernance;
}

export async function planContext(input: ContextPlanInput): Promise<MaterializedContextBundle> {
  const started = performance.now();
  const requirements = mergeRequirements([input.auditProfile, input.policyProfile]);
  const sourceMap = new Map(input.sources.map((source) => [source.capability, source]));
  const sections: ContextSection[] = [];
  const omissions: ContextOmission[] = [];
  const downgradedCapabilities: MaterializedContextBundle["manifest"]["downgradedCapabilities"] = [];
  let remainingTokens = input.governance.maxInputTokens;

  for (const requirement of requirements) {
    if (performance.now() - started > input.governance.maxMaterializationMs) {
      omissions.push(omission(requirement, "latency-budget"));
      continue;
    }

    const source = sourceMap.get(requirement.capability);
    if (!source?.available) {
      omissions.push(omission(requirement, "unavailable"));
      continue;
    }

    if (
      source.requiresProjectTrust &&
      input.governance.requireTrustedProject &&
      !input.governance.projectTrusted
    ) {
      omissions.push(omission(requirement, "untrusted-project"));
      continue;
    }

    if (
      requirement.capability === "project.named-context" &&
      input.governance.providerLocality === "cloud" &&
      !input.governance.allowCloudProjectContext
    ) {
      omissions.push(omission(requirement, "privacy-policy"));
      continue;
    }

    const preferred =
      requirement.preferredRepresentations.length > 0
        ? requirement.preferredRepresentations
        : source.supportedRepresentations;
    const allowed = preferred.filter((representation) => {
      if (!source.supportedRepresentations.includes(representation)) return false;
      if (
        requirement.capability === "prompt.images" &&
        representation === "original-images" &&
        input.governance.providerLocality === "cloud" &&
        !input.governance.allowCloudImages
      ) {
        return false;
      }
      return true;
    });
    const representation = allowed[0];
    if (!representation) {
      const privacyDenied =
        requirement.capability === "prompt.images" &&
        preferred.includes("original-images") &&
        !input.governance.allowCloudImages;
      omissions.push(omission(requirement, privacyDenied ? "privacy-policy" : "unsupported-representation"));
      continue;
    }

    if (preferred[0] && representation !== preferred[0]) {
      downgradedCapabilities.push({
        capability: requirement.capability,
        requestedRepresentation: preferred[0],
        grantedRepresentation: representation,
      });
    }

    const sectionBudget = Math.min(requirement.maxTokens ?? remainingTokens, remainingTokens);
    if (sectionBudget <= 0 || (source.estimatedTokens > sectionBudget && !source.truncatable)) {
      omissions.push(omission(requirement, "token-budget"));
      continue;
    }

    try {
      const remainingLatencyMs =
        input.governance.maxMaterializationMs - (performance.now() - started);
      const value = await materializeWithin(
        source,
        representation,
        sectionBudget,
        remainingLatencyMs,
      );
      if (value.estimatedTokens > remainingTokens || value.estimatedTokens > sectionBudget) {
        omissions.push(omission(requirement, "token-budget"));
        continue;
      }
      remainingTokens -= value.estimatedTokens;
      sections.push({
        capability: requirement.capability,
        representation,
        audience: requirement.audience,
        provenance: source.provenance,
        providerLocality: input.governance.providerLocality,
        sensitivity: source.sensitivity,
        content: value.content,
        estimatedTokens: value.estimatedTokens,
        truncated: value.truncated,
      });
    } catch (error) {
      omissions.push(
        omission(
          requirement,
          error instanceof LatencyBudgetExceeded ? "latency-budget" : "materialization-error",
        ),
      );
    }
  }

  const materializationLatencyMs = Math.max(0, performance.now() - started);
  const requestedCapabilities = requirements.map((requirement) => requirement.capability);
  const grantedCapabilities = sections.map((section) => section.capability);
  const unique = <T>(items: T[]): T[] => [...new Set(items)];

  const buildEnvelope = (audience: "audit" | "policy", profileId: string) => ({
    schemaVersion: "1" as const,
    audience,
    profileId,
    sections: sections.filter((section) => appliesToAudience(section.audience, audience)),
    omissions: omissions.filter((item) => appliesToAudience(item.audience, audience)),
  });

  return {
    audit: buildEnvelope("audit", input.auditProfile.id),
    policy: buildEnvelope("policy", input.policyProfile.id),
    manifest: {
      schemaVersion: "1",
      auditProfileId: input.auditProfile.id,
      policyProfileId: input.policyProfile.id,
      requestedCapabilities: unique(requestedCapabilities),
      grantedCapabilities: unique(grantedCapabilities),
      downgradedCapabilities,
      omittedCapabilities: omissions,
      sections: sections.map(({ content: _content, ...metadata }) => metadata),
      estimatedTokens: input.governance.maxInputTokens - remainingTokens,
      materializationLatencyMs,
      providerLocality: input.governance.providerLocality,
      projectTrustRequired: requirements.some(
        (requirement) => sourceMap.get(requirement.capability)?.requiresProjectTrust === true,
      ),
      projectTrusted: input.governance.projectTrusted,
    },
    requiredOmissions: omissions.filter((item) => item.strength === "required"),
  };
}
