import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

// Use an isolated agent directory; load real modules without running providers.
const agentDir = await mkdtemp(join(tmpdir(), "wasabi-audit-smoke-"));
try {
  for (const path of ["extensions/prompt-audit.ts", "."]) {
    const result = await discoverAndLoadExtensions([resolve(path)], process.cwd(), agentDir);
    assert.deepEqual(result.errors, [], "Pi must load the package without errors");
    const auditors = result.extensions.filter(extension => extension.commands.has("audit"));
    assert.equal(auditors.length, 1, "Only one auditor may be registered");
    for (const command of ["audit", "audit-status", "audit-english"]) {
      assert.ok(auditors[0].commands.has(command));
    }
    assert.ok(auditors[0].flags.has("audit-model"));
    assert.ok(auditors[0].handlers.has("input"));
    assert.ok(!result.extensions.some(extension => extension.commands.has("audit-jev")));
    if (path === ".") {
      assert.ok(result.extensions.some(extension => extension.commands.has("crunch")));
      assert.ok(result.extensions.some(extension => extension.commands.has("crop")));
    }
  }
  console.log("PASS: Pi loaded the compatibility entry and full Wasabi package, with one auditor and existing commands. No model calls.");
} finally {
  await rm(agentDir, { recursive: true, force: true });
}
