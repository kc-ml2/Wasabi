import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../screening/config.ts";
import { audit } from "../screening/engine.ts";
import type { AuditAction, ContextInput } from "../screening/types.ts";

export interface EvaluationCase {
  id: string;
  language: "en" | "ko" | "mixed";
  category: string;
  input: ContextInput;
  expectedAction: AuditAction;
  rationale: string;
}

const ACTIONS: AuditAction[] = ["PASS", "OBSERVE", "APPLY_SKILL", "ASK", "PROMOTE"];
const fixturePath = fileURLToPath(new URL("../examples/evaluation.jsonl", import.meta.url));

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function string(value: unknown, maximum = 64000): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}
function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

/** Labels are human-authored expectations for these synthetic scenarios, not model results. */
export function validateFixture(value: unknown): EvaluationCase {
  if (!object(value) || !onlyKeys(value, ["id", "language", "category", "input", "expectedAction", "rationale"]) ||
      !string(value.id, 100) || !/^[a-z0-9][a-z0-9_-]*$/.test(value.id) ||
      !["en", "ko", "mixed"].includes(String(value.language)) ||
      !string(value.category, 100) || !string(value.rationale, 4000) ||
      !ACTIONS.includes(value.expectedAction as AuditAction) || !object(value.input)) {
    throw new Error("Invalid fixture metadata");
  }
  const input = value.input;
  if (!onlyKeys(input, ["prompt", "recentMessages", "summary", "systemPrompt", "tools", "model", "cwd", "imageCount", "source", "streamingBehavior"]) || !string(input.prompt)) {
    throw new Error("Invalid fixture input");
  }
  for (const key of ["summary", "systemPrompt", "model", "cwd", "source", "streamingBehavior"]) {
    if (input[key] !== undefined && !string(input[key])) throw new Error(`Invalid fixture input.${key}`);
  }
  if (input.imageCount !== undefined && (typeof input.imageCount !== "number" || !Number.isSafeInteger(input.imageCount) || input.imageCount < 0)) {
    throw new Error("Invalid fixture input.imageCount");
  }
  if (input.recentMessages !== undefined && (!Array.isArray(input.recentMessages) || input.recentMessages.length > 32 || input.recentMessages.some(message =>
    !object(message) || !onlyKeys(message, ["role", "text"]) || !["user", "assistant"].includes(String(message.role)) || !string(message.text)))) {
    throw new Error("Invalid fixture input.recentMessages");
  }
  if (input.tools !== undefined && (!Array.isArray(input.tools) || input.tools.length > 40 || input.tools.some(tool =>
    !object(tool) || !onlyKeys(tool, ["name", "description"]) || !string(tool.name, 100) || !string(tool.description, 1000)))) {
    throw new Error("Invalid fixture input.tools");
  }
  return value as unknown as EvaluationCase;
}

export function readFixtures(path = fixturePath): EvaluationCase[] {
  const ids = new Set<string>();
  const cases: EvaluationCase[] = [];
  const contents = readFileSync(path, "utf8");
  if (contents.length > 2_000_000) throw new Error("Fixture file is too large");
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let item: EvaluationCase;
    try { item = validateFixture(JSON.parse(line)); }
    catch { throw new Error(`Invalid fixture at line ${index + 1}`); }
    if (ids.has(item.id)) throw new Error(`Duplicate fixture ID at line ${index + 1}`);
    ids.add(item.id);
    cases.push(item);
  }
  if (!cases.length) throw new Error("Fixture file is empty");
  return cases;
}

/** Nearest-rank percentile; meaningful only for the measured sample, not a latency SLA. */
export function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1))];
}

function percentage(numerator: number, denominator: number): string {
  return denominator ? `${(100 * numerator / denominator).toFixed(1)}% (${numerator}/${denominator})` : "n/a (no eligible cases)";
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes("--help")) {
    console.log("Usage: npm run audit:evaluate -- [--live] [--limit=N]\n\nDefault: validate synthetic fixture structure only; no network calls.\n--live: send the selected synthetic fixtures to the configured Jev endpoint and report measured decisions and latency.\n--limit=N: use the first N fixtures. The lightweight rewriter is never called.");
    return;
  }
  let live = false;
  let limit = Infinity;
  const seen = new Set<string>();
  for (const arg of args) {
    const flag = arg.split("=", 1)[0];
    if (seen.has(flag)) throw new Error("Duplicate evaluation argument");
    seen.add(flag);
    if (arg === "--live") live = true;
    else if (/^--limit=[1-9][0-9]*$/.test(arg)) {
      limit = Number(arg.slice("--limit=".length));
      if (!Number.isSafeInteger(limit)) throw new Error("Invalid evaluation limit");
    } else throw new Error("Unknown evaluation argument; use --help");
  }
  const allCases = readFixtures();
  const cases = allCases.slice(0, limit);
  const languages = Object.fromEntries(["en", "ko", "mixed"].map(language => [language, cases.filter(item => item.language === language).length]));
  console.log(`Validated ${allCases.length} synthetic fixtures; selected ${cases.length}. Languages: ${JSON.stringify(languages)}`);
  if (!live) {
    console.log("OFFLINE: structure validation only. No Jev calls, model-quality scores, or latency measurements were produced.");
    return;
  }

  const config = loadConfig();
  if (!process.env[config.jev.apiKeyEnv]?.trim()) throw new Error("Live evaluation requires the configured Jev API key");
  console.log(`LIVE: ${cases.length} Jev screening requests; model ${config.jev.model}. No rewriter requests.`);
  const records: { expected: AuditAction; actual: AuditAction; elapsedMs: number; screeningMs: number }[] = [];
  let failures = 0;
  for (const item of cases) {
    const started = performance.now();
    try {
      const result = await audit(item.input, config);
      const elapsedMs = performance.now() - started;
      records.push({ expected: item.expectedAction, actual: result.decision.action, elapsedMs, screeningMs: result.screening.latencyMs });
      console.log(`${item.id}: expected=${item.expectedAction} actual=${result.decision.action} total_ms=${elapsedMs.toFixed(1)}`);
    } catch {
      failures++;
      // Deliberately exclude provider bodies, prompt contents, and API-key-bearing errors.
      console.log(`${item.id}: ERROR (no decision; not counted as PASS)`);
    }
  }
  const completed = records.length;
  const positives = records.filter(item => item.expected === "ASK");
  const negatives = records.filter(item => item.expected !== "ASK");
  const predictedAsks = records.filter(item => item.actual === "ASK");
  const trueAsks = positives.filter(item => item.actual === "ASK").length;
  console.log(`\nCompleted: ${completed}/${cases.length}; errors: ${failures}`);
  console.log(`Exact action agreement among completed cases: ${percentage(records.filter(item => item.expected === item.actual).length, completed)}`);
  console.log(`ASK precision: ${percentage(trueAsks, predictedAsks.length)}`);
  console.log(`ASK recall: ${percentage(trueAsks, positives.length)}`);
  console.log(`False interruption rate (ASK among completed non-ASK labels): ${percentage(negatives.filter(item => item.actual === "ASK").length, negatives.length)}`);
  console.log("Confusion matrix (rows=expected; columns=actual):");
  console.log(["expected", ...ACTIONS].join("\t"));
  for (const expected of ACTIONS) console.log([expected, ...ACTIONS.map(actual => records.filter(item => item.expected === expected && item.actual === actual).length)].join("\t"));
  for (const [name, values] of [["Total audit", records.map(item => item.elapsedMs)], ["Jev screening", records.map(item => item.screeningMs)]] as const) {
    const p50 = percentile(values, 0.5);
    const p95 = percentile(values, 0.95);
    console.log(`${name} latency, successful requests only: p50=${p50 === null ? "n/a" : p50.toFixed(1) + "ms"}; p95=${p95 === null ? "n/a" : p95.toFixed(1) + "ms"}; n=${values.length}`);
  }
  console.log("These are small synthetic-fixture measurements, not a production accuracy or latency guarantee. Errors are excluded from agreement and latency denominators.");
  if (failures) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("Evaluation failed. Check arguments, fixture structure, configuration, and live API-key setup. No result was inferred.");
    process.exitCode = 1;
  });
}
