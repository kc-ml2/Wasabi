import { buildEnvelope } from "./context.ts";
import { decide } from "./policy.ts";
import { screen } from "./jev.ts";
import type { AuditResult, Config, ContextInput, Providers } from "./types.ts";

export const defaultProviders: Pick<Providers, "screen"> = { screen };
export async function audit(input: ContextInput, config: Config, providers = defaultProviders, signal?: AbortSignal): Promise<AuditResult> {
  const envelope = buildEnvelope(input, config);
  signal?.throwIfAborted();
  const screening = await providers.screen(envelope, config, signal);
  signal?.throwIfAborted();
  return { envelope, screening, decision: decide(screening, envelope, config) };
}
