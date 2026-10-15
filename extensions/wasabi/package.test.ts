import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

describe("Wasabi package loading", () => {
  it("loads and registers with Node's native TypeScript stripping", () => {
    // Jest transpilation previously hid syntax errors seen by the independent
    // check package's native Node loader. Exercise the entire entry-point graph.
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { readFile } from "node:fs/promises";
      const manifest = JSON.parse(await readFile("./package.json", "utf8"));
      for (const registered of manifest.pi.extensions) {
        assert.match(registered, /^\\.\\/extensions\\/[^/]+\\/index\\.ts$/,
          \`Invalid registered sub-extension: \${registered}\`);
        const { readdir } = await import("node:fs/promises");
        const directory = registered.slice(0, registered.lastIndexOf("/"));
        const files = await readdir(directory);
        assert(files.includes("README.md"), \`\${directory} needs usage documentation\`);
        assert(files.some(name => name.endsWith(".test.ts")), \`\${directory} needs colocated tests\`);
        const { default: extension } = await import(registered);
        assert.equal(typeof extension, "function");
        const registeredCommands = [];
        extension({
          on: () => {},
          registerCommand: name => registeredCommands.push(name),
          appendEntry: () => assert.fail("Loading must not persist configuration"),
        });
        assert(registeredCommands.length > 0, \`\${registered} must register its commands\`);
      }
      const entry = "./extensions/wasabi/index.ts";
      assert(manifest.pi.extensions.includes(entry));
      const { default: wasabi } = await import(entry);
      const events = [];
      const commands = [];
      wasabi({
        on: name => events.push(name),
        registerCommand: name => commands.push(name),
        appendEntry: () => assert.fail("Loading must not persist configuration"),
      }, () => assert.fail("Loading must not call a model"));
      assert(events.includes("input"));
      assert(events.includes("session_start"));
      assert(commands.includes("wasabi"));
      assert(commands.includes("wasabi-model"));
      console.log("Wasabi native package load passed");
    `], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    expect(output).toContain("Wasabi native package load passed");
  });
});
