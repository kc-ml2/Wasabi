import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./types.ts";

export const DEFAULT_CONFIG: Config = {
  mode: "shadow",
  jev: { url: "https://api.typesafe.ai/v1/systemone", model: "jev-1.13.0", apiKeyEnv: "TYPESAFE_API_KEY", timeoutMs: 1500 },
  rewrite: { baseUrl: "http://127.0.0.1:8000/v1", model: "", apiKeyEnv: "", timeoutMs: 20000, maxTokens: 1600 },
  context: { recentMessages: 8, maxContextChars: 16000, maxPromptChars: 24000, includeConversation: true, includeSystemPrompt: false, includeCwd: false },
  policy: { askThreshold: 0.85, observeThreshold: 0.75, uncertaintyLow: 0.35, uncertaintyHigh: 0.65, failure: "open", headless: "pass" },
  approvedConventions: [],
};

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}
export function parseConfig(value: unknown): Config {
  const raw = record(value, "config");
  const result = structuredClone(DEFAULT_CONFIG);
  for (const [key, val] of Object.entries(raw)) {
    if (!Object.hasOwn(result, key)) throw new Error(`Unknown configuration field: ${key}`);
    if (["jev", "rewrite", "context", "policy"].includes(key)) {
      const section = record(val, key);
      const target = result[key as "jev"] as unknown as Record<string, unknown>;
      for (const [name, item] of Object.entries(section)) {
        if (!Object.hasOwn(target, name)) throw new Error(`Unknown configuration field: ${key}.${name}`);
        target[name] = item;
      }
    } else (result as unknown as Record<string, unknown>)[key] = val;
  }
  function oneOf(value: unknown, options: string[], label: string) {
    if (typeof value !== "string" || !options.includes(value)) throw new Error(`Invalid ${label}`);
  }
  function number(value: unknown, min: number, max: number, label: string, integer = true) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`Invalid ${label}`);
  }
  oneOf(result.mode, ["off", "shadow", "review"], "mode");
  oneOf(result.policy.failure, ["open", "closed"], "policy.failure");
  oneOf(result.policy.headless, ["pass", "block"], "policy.headless");
  for (const [name, section] of [["jev", result.jev], ["rewrite", result.rewrite]] as const) {
    number(section.timeoutMs, 50, 120000, `${name}.timeoutMs`);
    if (typeof section.model !== "string" || section.model.length > 200 || (name === "jev" && !section.model.trim())) throw new Error(`Invalid ${name}.model`);
    if (typeof section.apiKeyEnv !== "string" || (section.apiKeyEnv !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(section.apiKeyEnv))) throw new Error(`Invalid ${name}.apiKeyEnv`);
    if (name === "jev" && !section.apiKeyEnv) throw new Error("jev.apiKeyEnv must name the JEV credential environment variable");
  }
  for (const value of [result.jev.url, result.rewrite.baseUrl]) {
    if (typeof value !== "string") throw new Error("Provider URL must be a string");
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("Invalid provider URL"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Provider URL must be HTTP(S) without embedded credentials, query, or fragment");
  }
  number(result.rewrite.maxTokens, 128, 8192, "rewrite.maxTokens");
  number(result.context.recentMessages, 0, 32, "context.recentMessages");
  number(result.context.maxContextChars, 0, 64000, "context.maxContextChars");
  number(result.context.maxPromptChars, 1, 64000, "context.maxPromptChars");
  for (const key of ["includeConversation", "includeSystemPrompt", "includeCwd"] as const) {
    if (typeof result.context[key] !== "boolean") throw new Error(`Invalid context.${key}`);
  }
  for (const key of ["askThreshold", "observeThreshold", "uncertaintyLow", "uncertaintyHigh"] as const) number(result.policy[key], 0, 1, `policy.${key}`, false);
  if (result.policy.uncertaintyLow >= result.policy.uncertaintyHigh || result.policy.uncertaintyHigh >= result.policy.askThreshold) throw new Error("Uncertainty interval must be ordered below askThreshold");
  if (!Array.isArray(result.approvedConventions) || result.approvedConventions.length > 16 || result.approvedConventions.some(x => typeof x !== "string" || x.length > 2000)) throw new Error("approvedConventions must contain at most 16 strings of 2000 characters");
  return result;
}

export function loadConfig(): Config {
  const explicitPath = process.env.PI_PROMPT_AUDITOR_CONFIG;
  const path = explicitPath || join(homedir(), ".pi", "agent", "prompt-auditor.json");
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if (!explicitPath && (error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_CONFIG);
    throw new Error("Cannot read prompt auditor configuration");
  }
  if (text.length > 65536) throw new Error("Prompt auditor configuration exceeds 64 KiB");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Prompt auditor configuration is not valid JSON"); }
  return parseConfig(value);
}
