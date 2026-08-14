import { test } from "@jest/globals";
import assert from "node:assert/strict";
import { frontierV1Profile } from "../src/prompt-audit/context/profiles/frontier-v1.ts";
import { createConfig } from "../src/prompt-audit/config.ts";
import { createMvpContextSources } from "../src/prompt-audit/context/materializer.ts";

const subject = {
  schemaVersion: "1",
  text: "Use the image to update this.",
  source: "interactive",
  imageCount: 1,
  englishMode: "semantic-only",
};

test("frontier-v1 declares bounded audience-specific requirements", () => {
  const profile = frontierV1Profile(subject);
  const byCapability = new Map(profile.requirements.map((item) => [item.capability, item]));
  assert.equal(profile.id, "frontier-v1");
  assert.equal(profile.supportsIncrementalExpansion, false);
  assert.equal(byCapability.get("prompt.raw").strength, "required");
  assert.equal(byCapability.get("conversation.recent").maxItems, 12);
  assert.equal(byCapability.get("conversation.recent").audience, "audit");
  assert.equal(byCapability.get("user.audit-policy").audience, "policy");
  assert.deepEqual(byCapability.get("prompt.images").preferredRepresentations, [
    "original-images",
    "image-metadata-v1",
  ]);
  assert.equal(byCapability.has("project.named-context"), false);
});

test("the source registry exposes canonical capabilities without project I/O", () => {
  const sources = createMvpContextSources({
    subject,
    images: [{ type: "image", data: "abc", mimeType: "image/png" }],
    conversation: [],
    systemPrompt: "full prompt",
    systemPromptDigest: "digest",
    activeTools: [],
    workingDirectory: "/project",
    runtime: { mode: "tui", state: "idle" },
    config: createConfig(),
    deterministicFeatures: {},
    modelSupportsImages: false,
  });
  const byCapability = new Map(sources.map((item) => [item.capability, item]));
  assert.equal(byCapability.has("prompt.image-metadata"), true);
  assert.equal(byCapability.has("agent.system-prompt-full"), true);
  assert.equal(byCapability.get("project.named-context").available, false);
  assert.equal(sources.every((item) => item.performsIO === false), true);
});
