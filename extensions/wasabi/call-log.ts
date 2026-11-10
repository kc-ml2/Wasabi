import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

/** Capture the destination once, before invoking the provider. */
export function createCallFileWriter(sessionId: string, cwd: string, directory = process.env.WASABI_LOG_DIR) {
  if (!directory?.trim()) return undefined;
  const root = resolve(cwd, directory);
  // Session IDs normally are UUIDs; encoding also prevents path traversal.
  const file = resolve(root, `${encodeURIComponent(sessionId)}.wasabi.jsonl`);
  return (record: Record<string, unknown>): void => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  };
}
