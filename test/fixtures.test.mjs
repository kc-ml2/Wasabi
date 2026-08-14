import { test } from "@jest/globals";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readJsonl(name) {
  const text = await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  return text.trim().split("\n").map((line) => JSON.parse(line));
}

test("the MVP corpus contains ten clear and ten materially ambiguous fixtures", async () => {
  const clear = await readJsonl("clear.jsonl");
  const ambiguous = await readJsonl("ambiguous.jsonl");
  assert.equal(clear.length, 10);
  assert.equal(ambiguous.length, 10);
  assert.equal(clear.every((item) => item.expected === "pass"), true);
  assert.equal(ambiguous.every((item) => item.expected === "review" || item.expected === "block"), true);
});
