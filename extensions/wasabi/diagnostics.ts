import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, openSync } from "node:fs";

/** Explicit opt-in: logs contain private conversation and model output, not credentials. */
export function createCheckDiagnostic(): (event: string, data: unknown) => void {
  const path = process.env.WASABI_DIAGNOSTIC_LOG;
  const request_id = randomUUID();
  return (event, data) => {
    if (!path) return;
    let fd: number | undefined;
    try {
      fd = openSync(path, "a", 0o600);
      chmodSync(path, 0o600);
      appendFileSync(fd, JSON.stringify({ timestamp: new Date().toISOString(), request_id, event, data }) + "\n");
    } catch {
      // Diagnostics must never change the checking/approval outcome.
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* best effort */ }
      }
    }
  };
}
