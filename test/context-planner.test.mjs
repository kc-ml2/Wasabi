import { test } from "@jest/globals";
import assert from "node:assert/strict";
import { planContext } from "../src/prompt-audit/context/planner.ts";

const profile = (id, requirements) => ({
  id,
  schemaVersion: "1",
  requirements,
  supportsIncrementalExpansion: false,
});
const source = (capability, value, overrides = {}) => ({
  capability,
  available: true,
  provenance: "test",
  sensitivity: "low",
  estimatedTokens: 10,
  supportedRepresentations: ["v1"],
  requiresProjectTrust: false,
  performsIO: false,
  truncatable: false,
  materialize: async (representation) => ({
    content: value,
    estimatedTokens: 10,
    truncated: false,
    representation,
  }),
  ...overrides,
});
const governance = {
  maxInputTokens: 100,
  maxMaterializationMs: 500,
  allowCloudProjectContext: false,
  allowCloudImages: true,
  requireTrustedProject: true,
  projectTrusted: true,
  providerLocality: "cloud",
};

test("planner partitions audit-only and policy-only context", async () => {
  const bundle = await planContext({
    auditProfile: profile("audit-v1", [
      {
        capability: "conversation.recent",
        audience: "audit",
        strength: "required",
        preferredRepresentations: ["v1"],
        reason: "test",
      },
    ]),
    policyProfile: profile("policy-v1", [
      {
        capability: "user.audit-policy",
        audience: "policy",
        strength: "required",
        preferredRepresentations: ["v1"],
        reason: "test",
      },
    ]),
    sources: [source("conversation.recent", "secret conversation"), source("user.audit-policy", {})],
    governance,
  });
  assert.deepEqual(bundle.audit.sections.map((item) => item.capability), ["conversation.recent"]);
  assert.deepEqual(bundle.policy.sections.map((item) => item.capability), ["user.audit-policy"]);
});

test("conflicting representations of one capability preserve audience boundaries", async () => {
  const sharedSource = source("prompt.metadata", { source: "interactive" }, {
    supportedRepresentations: ["audit-detail", "policy-summary"],
  });
  const bundle = await planContext({
    auditProfile: profile("audit-v1", [
      {
        capability: "prompt.metadata",
        audience: "audit",
        strength: "required",
        preferredRepresentations: ["audit-detail"],
        reason: "test",
      },
    ]),
    policyProfile: profile("policy-v1", [
      {
        capability: "prompt.metadata",
        audience: "policy",
        strength: "required",
        preferredRepresentations: ["policy-summary"],
        reason: "test",
      },
    ]),
    sources: [sharedSource],
    governance,
  });
  assert.equal(bundle.audit.sections[0].representation, "audit-detail");
  assert.equal(bundle.policy.sections[0].representation, "policy-summary");
  assert.equal(bundle.audit.sections.some((item) => item.representation === "policy-summary"), false);
  assert.equal(bundle.policy.sections.some((item) => item.representation === "audit-detail"), false);
});

test("image content is downgraded to metadata when cloud images are disabled", async () => {
  const bundle = await planContext({
    auditProfile: profile("audit-v1", [
      {
        capability: "prompt.images",
        audience: "audit",
        strength: "preferred",
        preferredRepresentations: ["original-images", "image-metadata-v1"],
        reason: "test",
      },
    ]),
    policyProfile: profile("policy-v1", []),
    sources: [
      source("prompt.images", [{ mimeType: "image/png" }], {
        supportedRepresentations: ["original-images", "image-metadata-v1"],
      }),
    ],
    governance: { ...governance, allowCloudImages: false },
  });
  assert.equal(bundle.audit.sections[0].representation, "image-metadata-v1");
  assert.equal(bundle.manifest.downgradedCapabilities.length, 1);
});

test("untrusted project context and over-budget required context are explicit omissions", async () => {
  const requirement = {
    capability: "project.named-context",
    audience: "audit",
    strength: "required",
    preferredRepresentations: ["v1"],
    reason: "test",
  };
  const untrusted = await planContext({
    auditProfile: profile("audit-v1", [requirement]),
    policyProfile: profile("policy-v1", []),
    sources: [source("project.named-context", "secret", { requiresProjectTrust: true })],
    governance: { ...governance, projectTrusted: false },
  });
  assert.equal(untrusted.requiredOmissions[0].reason, "untrusted-project");

  const overBudget = await planContext({
    auditProfile: profile("audit-v1", [{ ...requirement, capability: "prompt.raw" }]),
    policyProfile: profile("policy-v1", []),
    sources: [source("prompt.raw", "very long", { estimatedTokens: 50 })],
    governance: { ...governance, maxInputTokens: 10 },
  });
  assert.equal(overBudget.requiredOmissions[0].reason, "token-budget");
});

test("manifest contains metadata but never source content", async () => {
  const secret = "never-log-this-raw-value";
  const bundle = await planContext({
    auditProfile: profile("audit-v1", [
      {
        capability: "prompt.raw",
        audience: "both",
        strength: "required",
        preferredRepresentations: ["v1"],
        reason: "test",
      },
    ]),
    policyProfile: profile("policy-v1", []),
    sources: [source("prompt.raw", secret)],
    governance,
  });
  assert.equal(JSON.stringify(bundle.manifest).includes(secret), false);
});

test("materialization latency is bounded and reported as an omission", async () => {
  const slow = source("conversation.recent", "late", {
    materialize: async () => new Promise(() => {}),
  });
  const bundle = await planContext({
    auditProfile: profile("audit-v1", [
      {
        capability: "conversation.recent",
        audience: "audit",
        strength: "required",
        preferredRepresentations: ["v1"],
        reason: "test",
      },
    ]),
    policyProfile: profile("policy-v1", []),
    sources: [slow],
    governance: { ...governance, maxMaterializationMs: 10 },
  });
  assert.equal(bundle.requiredOmissions[0].reason, "latency-budget");
});
