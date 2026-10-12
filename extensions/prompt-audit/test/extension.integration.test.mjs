import { test } from "@jest/globals";
import assert from "node:assert/strict";
import { createPromptAudit } from "../index.ts";
import { parseConfig } from "../screening/config.ts";
import { DETECTOR_IDS } from "../screening/types.ts";
import { screen as realScreen } from "../screening/jev.ts";
import { REVIEW_CHOICES } from "../ui.ts";

const clearReport = {
  schemaVersion: "1",
  intentSummary: "Run the tests.",
  issues: [],
  auditorConfidence: 0.96,
  recommendedDecision: "pass",
};

const ambiguousReport = {
  schemaVersion: "1",
  intentSummary: "Update an unspecified parser.",
  issues: [
    {
      id: "ref-1",
      kind: "ambiguous_reference",
      severity: "warning",
      confidence: 0.92,
      materiality: 0.84,
      quote: "it",
      explanation: "The parser to update is not identified.",
      clarificationQuestion: "Which parser should be updated?",
    },
  ],
  revisedPrompt: "Update src/parser.ts and run its tests.",
  auditorConfidence: 0.93,
  recommendedDecision: "warn",
};

const criticalReport = {
  ...ambiguousReport,
  issues: [{ ...ambiguousReport.issues[0], severity: "critical", kind: "contradiction" }],
  recommendedDecision: "block",
};

function response(report) {
  return {
    role: "assistant",
    content: [{ type: "text", text: JSON.stringify(report) }],
    stopReason: "stop",
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
  };
}

function scores(overrides = {}) {
  return { probabilities: { ...Object.fromEntries(DETECTOR_IDS.map(id => [id, 0.01])), ...overrides }, model: "mock-jev", latencyMs: 2 };
}

function harness({
  reports = [clearReport],
  choices = [],
  edits = [],
  hasUI = true,
  hasAuth = true,
  auditEnabled = true,
  provider = "test-provider",
  complete,
  screen = async () => scores({ unsupported_capability: 0.99 }),
  loadScreeningConfig = () => parseConfig({}),
} = {}) {
  const handlers = new Map();
  const commands = new Map();
  const flags = new Map();
  const entries = [];
  const notifications = [];
  const statuses = [];
  const requests = [];
  const screeningRequests = [];
  const restored = [];
  const selectionOptions = [];
  const selectionTitles = [];
  const navigations = [];
  const sentUserMessages = [];
  let reportIndex = 0;
  let entryIndex = 0;
  let leafId = null;

  const pi = {
    registerFlag(name, options) {
      flags.set(name, options.default);
    },
    getFlag(name) {
      return flags.get(name);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
    appendEntry(customType, data) {
      const entry = { id: `entry-${++entryIndex}`, parentId: leafId, type: "custom", customType, data };
      entries.push(entry);
      leafId = entry.id;
    },
    sendUserMessage(content, options) {
      sentUserMessages.push({ content, options });
    },
    getActiveTools() {
      return ["read", "bash"];
    },
    getAllTools() {
      return [
        { name: "read", description: "Read a file." },
        { name: "bash", description: "Run a shell command." },
      ];
    },
  };
  createPromptAudit({
    loadScreeningConfig,
    screen: async (envelope, config, signal) => {
      screeningRequests.push({ envelope, config, signal });
      return screen(envelope, config, signal);
    },
  })(pi);

  const model = {
    id: "frontier-test",
    provider,
    baseUrl: "https://models.example.test",
    input: ["text", "image"],
  };
  const ui = {
    setEditorText(text) { restored.push(text); },
    notify(message, type) {
      notifications.push({ message, type });
    },
    setStatus(key, value) {
      statuses.push({ key, value });
    },
    async select(title, options) {
      selectionTitles.push(title);
      selectionOptions.push(options);
      return choices.shift();
    },
    async editor() {
      return edits.shift();
    },
  };
  const ctx = {
    hasUI,
    mode: hasUI ? "tui" : "print",
    ui,
    cwd: "/workspace/project",
    model,
    signal: undefined,
    modelRegistry: {
      hasConfiguredAuth: () => hasAuth,
      find: () => undefined,
      async complete(_model, context, options) {
        requests.push({ context, options });
        if (complete) return complete({ context, options, call: requests.length });
        const selected = reports[Math.min(reportIndex, reports.length - 1)];
        reportIndex += 1;
        return response(selected);
      },
    },
    sessionManager: {
      buildContextEntries() {
        return this.getBranch();
      },
      getBranch() {
        const branch = [];
        let entry = entries.find((candidate) => candidate.id === leafId);
        while (entry) {
          branch.unshift(entry);
          entry = entries.find((candidate) => candidate.id === entry.parentId);
        }
        return branch;
      },
      getLeafId() {
        return leafId;
      },
      getSessionId() {
        return "test-session-id";
      },
    },
    isProjectTrusted: () => true,
    isIdle: () => true,
    getSystemPrompt: () => "You are a coding agent.\nUse the available tools carefully.",
    async navigateTree(targetId) {
      navigations.push(targetId);
      leafId = targetId;
      return { cancelled: false };
    },
  };

  if (auditEnabled) {
    pi.appendEntry("prompt-audit-settings", {
      schemaVersion: "1",
      mode: "advisory",
      englishMode: "semantic-only",
    });
    handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    entries.length = 0;
    leafId = null;
  }

  return {
    input: handlers.get("input"),
    commands,
    flags,
    entries,
    notifications,
    statuses,
    requests,
    screeningRequests,
    restored,
    selectionOptions,
    selectionTitles,
    navigations,
    sentUserMessages,
    emit(name, event = { type: name }) {
      return handlers.get(name)?.(event, ctx);
    },
    ctx,
  };
}

test("prompt audit is opt-in and restores branch-local settings", async () => {
  const h = harness({ auditEnabled: false, reports: [clearReport] });

  assert.deepEqual(
    await h.input({ type: "input", text: "Run npm test", source: "interactive" }, h.ctx),
    { action: "continue" },
  );
  assert.equal(h.requests.length, 0);

  await h.commands.get("audit").handler("on", h.ctx);
  const enabledEntry = h.entries.at(-1);
  await h.commands.get("audit").handler("off", h.ctx);
  await h.ctx.navigateTree(enabledEntry.id);
  await h.emit("session_tree");

  await h.input({ type: "input", text: "Run npm test", source: "interactive" }, h.ctx);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(enabledEntry.data, {
    schemaVersion: "1",
    mode: "advisory",
    englishMode: "semantic-only",
  });
});

test("nested audits keep Wasabi's LiteLLM session header", async () => {
  const h = harness({ provider: "openai" });
  await h.input({ type: "input", text: "Run npm test", source: "interactive" }, h.ctx);

  assert.deepEqual(await h.requests[0].options.transformHeaders({ authorization: "Bearer test" }), {
    authorization: "Bearer test",
    "x-litellm-session-id": "test-session-id",
  });
});

test("clear prompts pass unchanged and write content-free audit metadata", async () => {
  const h = harness();
  const result = await h.input(
    { type: "input", text: "Run npm test", source: "interactive" },
    h.ctx,
  );
  assert.deepEqual(result, { action: "continue" });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].options.sessionId, "test-session-id");
  assert.deepEqual(await h.requests[0].options.transformHeaders({ existing: "header" }), {
    existing: "header",
  });
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries.some((entry) => entry.customType === "prompt-audit-dev"), false);
  assert.equal(JSON.stringify(h.entries).includes("Run npm test"), false);
});

test("dev mode stores raw audit preference data but only image metadata", async () => {
  const h = harness({ reports: [ambiguousReport], choices: [REVIEW_CHOICES.apply] });
  await h.commands.get("audit").handler("dev", h.ctx);
  const imageData = "aGVsbG8=";
  const result = await h.input(
    {
      type: "input",
      text: "Update it for the private customer",
      images: [{ type: "image", data: imageData, mimeType: "image/png" }],
      source: "interactive",
    },
    h.ctx,
  );

  assert.equal(result.action, "transform");
  assert.equal(
    h.notifications.some(
      (item) => item.type === "warning" && item.message.includes("may contain secrets"),
    ),
    true,
  );

  const devRecord = h.entries.find((entry) => entry.customType === "prompt-audit-dev");
  assert.ok(devRecord);
  assert.equal(devRecord.data.datasetVersion, "prompt-audit-rl-v1");
  assert.equal(devRecord.data.privacy, "raw-opt-in");
  assert.equal(devRecord.data.captureMode, "dev");
  assert.equal(devRecord.data.attempt, 0);
  assert.equal(devRecord.data.initialInput.text, "Update it for the private customer");
  assert.deepEqual(devRecord.data.initialInput.images, [
    { mimeType: "image/png", encodedBytes: imageData.length },
  ]);
  assert.deepEqual(devRecord.data.auditor, {
    engineId: "frontier-combined",
    engineVersion: "1.0.0",
    provider: "test-provider",
    modelId: "frontier-test",
  });
  assert.deepEqual(devRecord.data.auditorResponses, [JSON.stringify(ambiguousReport)]);
  assert.deepEqual(devRecord.data.normalizedReport, ambiguousReport);
  assert.deepEqual(devRecord.data.userSelection, {
    kind: "apply-suggested",
    submittedText: ambiguousReport.revisedPrompt,
  });
  const requestText = h.requests[0].context.messages[0].content[0].text;
  assert.equal(requestText.includes('"mode":"advisory"'), true);
  assert.equal(requestText.includes('"mode":"dev"'), false);
  assert.equal(JSON.stringify(devRecord).includes(imageData), false);
});

test("one-shot experiment stores both sibling responses and leaves the selected input last", async () => {
  const h = harness({ reports: [ambiguousReport, clearReport], choices: [REVIEW_CHOICES.apply] });
  const navigate = h.ctx.navigateTree;
  h.ctx.navigateTree = async (id) => {
    const result = await navigate(id);
    await h.emit("session_tree");
    return result;
  };
  const imageData = "cHJpdmF0ZS1pbWFnZQ==";
  const images = [{ type: "image", data: imageData, mimeType: "image/png" }];
  await h.commands.get("audit").handler("experiment", h.ctx);

  const first = await h.input(
    { type: "input", text: "Update it", images, source: "interactive" },
    h.ctx,
  );
  assert.deepEqual(first, { action: "continue" });
  const devRecord = h.entries.find((entry) => entry.customType === "prompt-audit-dev");
  assert.ok(devRecord);
  assert.equal(devRecord.data.captureMode, "experiment");

  const blocked = await h.input(
    { type: "input", text: "Do not queue this turn", source: "interactive" },
    h.ctx,
  );
  assert.deepEqual(blocked, { action: "handled" });
  assert.equal(h.requests.length, 1);

  const initialAssistant = {
    role: "assistant",
    content: [{ type: "text", text: "Result from the initial prompt" }],
    api: "test",
    provider: "test-provider",
    model: "frontier-test",
    stopReason: "stop",
    usage: { input: 20, output: 10 },
    timestamp: 1,
  };
  await h.emit("agent_end", {
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "Update it" }], timestamp: 0 },
      initialAssistant,
    ],
  });
  await h.emit("agent_settled");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(h.sentUserMessages.length, 1);
  const continuation = h.sentUserMessages[0];
  assert.equal(continuation.options.expandPromptTemplates, true);
  assert.equal(continuation.content.startsWith("/audit __continue-experiment "), true);
  await h.commands.get("audit").handler(
    continuation.content.slice("/audit ".length),
    h.ctx,
  );

  assert.deepEqual(h.navigations, [devRecord.id]);
  assert.equal(h.sentUserMessages.length, 2);
  assert.equal(h.sentUserMessages[1].content[0].text, ambiguousReport.revisedPrompt);
  assert.deepEqual(h.sentUserMessages[1].content.slice(1), images);

  const candidateAssistant = {
    ...initialAssistant,
    content: [{ type: "text", text: "Result from the clearer candidate" }],
    timestamp: 2,
  };
  await h.emit("agent_end", {
    type: "agent_end",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: ambiguousReport.revisedPrompt }],
        timestamp: 1,
      },
      candidateAssistant,
    ],
  });
  await h.emit("agent_settled");

  const experiment = h.entries.find((entry) => entry.customType === "prompt-audit-experiment");
  assert.ok(experiment);
  assert.equal(experiment.data.auditSubmissionId, devRecord.data.submissionId);
  assert.equal(experiment.data.commonContextEntryId, devRecord.id);
  assert.equal(experiment.data.selectedAlternative, "candidate");
  assert.deepEqual(experiment.data.executionOrder, ["initial", "candidate"]);
  assert.equal(experiment.data.alternatives.initial.text, "Update it");
  assert.equal(experiment.data.alternatives.candidate.text, ambiguousReport.revisedPrompt);
  assert.equal(
    experiment.data.runs[0].assistantMessages[0].content[0].text,
    "Result from the initial prompt",
  );
  assert.equal(experiment.data.runs[0].finalText, "Result from the initial prompt");
  assert.equal(
    experiment.data.runs[1].assistantMessages[0].content[0].text,
    "Result from the clearer candidate",
  );
  assert.equal(experiment.data.runs[1].finalText, "Result from the clearer candidate");
  assert.equal(experiment.data.externalSideEffectsIsolated, false);
  assert.equal(JSON.stringify(experiment).includes(imageData), false);

  const next = await h.input(
    { type: "input", text: "Run the next check", source: "interactive" },
    h.ctx,
  );
  assert.deepEqual(next, { action: "continue" });
  assert.equal(h.entries.filter((entry) => entry.customType === "prompt-audit-experiment").length, 1);
  assert.equal(h.entries.filter((entry) => entry.customType === "prompt-audit-dev").length, 1);
});

test("leaving dev mode stops raw dataset capture", async () => {
  const h = harness({ reports: [clearReport, clearReport] });
  await h.commands.get("audit").handler("dev", h.ctx);
  await h.input({ type: "input", text: "First raw prompt", source: "interactive" }, h.ctx);
  await h.commands.get("audit").handler("on", h.ctx);
  await h.input({ type: "input", text: "Second private prompt", source: "interactive" }, h.ctx);

  const devRecords = h.entries.filter((entry) => entry.customType === "prompt-audit-dev");
  assert.equal(devRecords.length, 1);
  assert.equal(devRecords[0].data.initialInput.text, "First raw prompt");
  assert.equal(JSON.stringify(h.entries).includes("Second private prompt"), false);
});

test("approved revisions transform text and preserve attached images", async () => {
  const h = harness({ reports: [ambiguousReport], choices: [REVIEW_CHOICES.apply] });
  const images = [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }];
  const result = await h.input(
    { type: "input", text: "Update it", images, source: "interactive" },
    h.ctx,
  );
  assert.deepEqual(result, {
    action: "transform",
    text: ambiguousReport.revisedPrompt,
    images,
  });
});

test("cancelling review handles the input without a target-model turn", async () => {
  const h = harness({ reports: [ambiguousReport], choices: [REVIEW_CHOICES.cancel] });
  const result = await h.input(
    { type: "input", text: "Update it", source: "interactive" },
    h.ctx,
  );
  assert.deepEqual(result, { action: "handled" });
  assert.equal(h.entries[0].data.userAction, "cancelled");
});

test("editing performs at most one re-audit and forwards a clear edit", async () => {
  const h = harness({
    reports: [ambiguousReport, clearReport],
    choices: [REVIEW_CHOICES.edit],
    edits: ["Update src/parser.ts and run its tests."],
  });
  const result = await h.input(
    { type: "input", text: "Update it", source: "interactive" },
    h.ctx,
  );
  assert.deepEqual(result, {
    action: "transform",
    text: "Update src/parser.ts and run its tests.",
    images: undefined,
  });
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.entries.map((entry) => entry.data.userAction), ["edited-and-reaudited", "passed"]);
});

test("strict critical findings remove apply and original override choices", async () => {
  const h = harness({ reports: [criticalReport], choices: [REVIEW_CHOICES.cancel] });
  await h.commands.get("audit").handler("strict", h.ctx);
  const result = await h.input(
    { type: "input", text: "Do it and do not do it", source: "interactive" },
    h.ctx,
  );
  assert.deepEqual(result, { action: "handled" });
  assert.deepEqual(h.selectionOptions[0], [REVIEW_CHOICES.edit, REVIEW_CHOICES.cancel]);
});

test("one-shot English polish applies to one eligible prompt", async () => {
  const h = harness({ reports: [clearReport, clearReport] });
  await h.commands.get("audit-english").handler("next", h.ctx);
  await h.input({ type: "input", text: "Please improves this", source: "interactive" }, h.ctx);
  await h.input({ type: "input", text: "Run the checks", source: "interactive" }, h.ctx);
  const first = h.requests[0].context.messages[0].content[0].text;
  const second = h.requests[1].context.messages[0].content[0].text;
  assert.equal(first.includes('"englishMode":"polish"'), true);
  assert.equal(second.includes('"englishMode":"semantic-only"'), true);
});

test("English polish review displays structured diff-like changes and reasons", async () => {
  const polishReport = {
    schemaVersion: "1",
    intentSummary: "Search for input-clarity auditing extensions.",
    issues: [
      {
        id: "english-1",
        kind: "english_polish",
        severity: "info",
        confidence: 0.96,
        materiality: 0.1,
        explanation: "Use a more idiomatic noun phrase.",
      },
    ],
    revisedPrompt: "I want to search for Pi extensions that audit the clarity of user input.",
    englishChanges: [
      {
        original: "audits users input clearness",
        replacement: "audit the clarity of user input",
        reason: "Use subject-verb agreement, a possessive construction, and the idiomatic noun clarity.",
      },
    ],
    auditorConfidence: 0.97,
    recommendedDecision: "warn",
  };
  const h = harness({ reports: [polishReport], choices: [REVIEW_CHOICES.cancel] });
  await h.commands.get("audit-english").handler("always", h.ctx);
  await h.input(
    {
      type: "input",
      text: "I want to search for PI extensions that audits users input clearness",
      source: "interactive",
    },
    h.ctx,
  );
  const title = h.selectionTitles[0];
  assert.equal(title.includes('Language changes (1):'), true);
  assert.equal(title.includes('- "audits users input clearness"'), true);
  assert.equal(title.includes('+ "audit the clarity of user input"'), true);
  assert.equal(title.includes("Reason: Use subject-verb agreement"), true);
});

test("auditor failures warn and fail open without disabling Pi", async () => {
  const h = harness({
    complete: async () => {
      throw new Error("provider unavailable");
    },
  });
  const result = await h.input(
    { type: "input", text: "Implement the change", source: "interactive" },
    h.ctx,
  );
  assert.deepEqual(result, { action: "continue" });
  assert.equal(h.notifications.some((item) => item.message.includes("sending the original")), true);
  assert.equal(h.entries[0].data.userAction, "failure-opened");
});

test("missing authentication fails open before making a completion", async () => {
  const h = harness({ hasAuth: false });
  const result = await h.input(
    { type: "input", text: "Implement the change", source: "interactive" },
    h.ctx,
  );
  assert.deepEqual(result, { action: "continue" });
  assert.equal(h.requests.length, 0);
  assert.equal(h.notifications.some((item) => item.message.includes("Check reviewer configuration and authentication")), true);
});

test("extension-originated input never recurses and headless review fails open", async () => {
  const bypass = harness();
  assert.deepEqual(
    await bypass.input({ type: "input", text: "hello", source: "extension" }, bypass.ctx),
    { action: "continue" },
  );
  assert.equal(bypass.requests.length, 0);

  const headless = harness({ reports: [ambiguousReport], hasUI: false });
  assert.deepEqual(
    await headless.input({ type: "input", text: "Update it", source: "rpc" }, headless.ctx),
    { action: "continue" },
  );
  assert.equal(headless.entries[0].data.userAction, "headless-forwarded");
});

const inputEvent = (text = "Run the tests", extra = {}) => ({ type: "input", text, source: "interactive", ...extra });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("JEV clear path uses no reviewer credentials and logs only screening metadata", async () => {
  const h = harness({ screen: async () => scores(), hasAuth: false });
  h.ctx.modelRegistry.hasConfiguredAuth = () => { throw new Error("Reviewer must not be resolved"); };
  const prompt = "  Run the private-project tests.\n";
  assert.deepEqual(await h.input(inputEvent(prompt), h.ctx), { action: "continue" });
  assert.equal(h.screeningRequests.length, 1);
  assert.equal(h.requests.length, 0);
  assert.equal(h.selectionOptions.length, 0);
  assert.equal(h.screeningRequests[0].envelope.prompt, prompt);
  const record = h.entries[0].data;
  assert.equal(record.auditEngine.id, "jev-screen");
  assert.equal(record.screening.action, "PASS");
  assert.equal(record.screening.route, "pass");
  assert.equal(record.findings, undefined);
  assert.equal(record.promptHash.length, 64);
  assert.equal(JSON.stringify(h.entries).includes(prompt.trim()), false);
});

test("uncertain and discoverable-evidence screenings never invoke the reviewer", async () => {
  for (const [probabilities, action] of [
    [{ missing_user_choice: 0.5 }, "PROMOTE"],
    [{ missing_evidence: 0.98 }, "OBSERVE"],
  ]) {
    const h = harness({ screen: async () => scores(probabilities) });
    assert.deepEqual(await h.input(inputEvent(), h.ctx), { action: "continue" });
    assert.equal(h.requests.length, 0);
    assert.equal(h.entries[0].data.screening.action, action);
  }
});

test("a strong finding automatically invokes Pi but a clear detailed report does not interrupt", async () => {
  const h = harness({ screen: async () => scores({ missing_user_choice: 0.95 }) });
  assert.deepEqual(await h.input(inputEvent(), h.ctx), { action: "continue" });
  assert.equal(h.screeningRequests.length, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.selectionOptions.length, 0);
  assert.equal(h.entries[0].data.screening.route, "review");
});

test("JEV has bounded active-branch context without tools, thinking, image pixels, cwd, or system text", async () => {
  const h = harness({ screen: async () => scores({ unresolved_reference: 0.99 }) });
  h.ctx.sessionManager.getBranch = () => { throw new Error("Use compaction-aware context"); };
  h.ctx.sessionManager.buildContextEntries = () => [
    { type: "compaction", summary: "The chosen output is CSV." },
    { type: "message", message: { role: "user", content: "Keep that format" } },
    { type: "message", message: { role: "assistant", content: [
      { type: "text", text: "CSV is selected." }, { type: "thinking", thinking: "secret reasoning" },
    ] } },
    { type: "message", message: { role: "toolResult", content: "secret tool result" } },
  ];
  const images = [{ type: "image", data: "private-image-data", mimeType: "image/png" }];
  assert.deepEqual(await h.input(inputEvent("Use this", { images }), h.ctx), { action: "continue" });
  const envelope = h.screeningRequests[0].envelope;
  assert.equal(envelope.summary, "The chosen output is CSV.");
  assert.deepEqual(envelope.recentMessages.map(message => message.text), ["Keep that format", "CSV is selected."]);
  assert.equal(envelope.runtime.imageCount, 1);
  assert.equal(envelope.cwd, undefined);
  assert.equal(envelope.systemPrompt, undefined);
  for (const secret of ["secret reasoning", "secret tool result", "private-image-data"]) {
    assert.equal(JSON.stringify(envelope).includes(secret), false);
    assert.equal(JSON.stringify(h.entries).includes(secret), false);
  }
  assert.equal(h.entries[0].data.screening.action, "PROMOTE");
  assert.equal(h.requests.length, 0);
});

test("invalid screening config and provider failures fall back without leaking error details", async () => {
  for (const settings of [
    { loadScreeningConfig: () => { throw new Error("private config content"); } },
    { screen: async () => { throw new Error("private config content"); } },
  ]) {
    const h = harness(settings);
    assert.deepEqual(await h.input(inputEvent(), h.ctx), { action: "continue" });
    assert.equal(h.requests.length, 1);
    assert.equal(h.entries[0].data.screening.route, "fallback");
    assert.equal(h.entries[0].data.screening.status, "failed");
    assert.equal(JSON.stringify([h.notifications, h.entries]).includes("private config content"), false);
    assert.ok(h.notifications.some(item => item.message.includes("using the Pi prompt reviewer")));
  }
});

test("JEV and reviewer failure still forwards only the original and records the fallback", async () => {
  const h = harness({
    screen: async () => { throw new Error("secret JEV response"); },
    complete: async () => { throw new Error("secret reviewer response"); },
  });
  assert.deepEqual(await h.input(inputEvent(), h.ctx), { action: "continue" });
  assert.equal(h.requests.length, 1);
  assert.equal(h.entries[0].data.userAction, "failure-opened");
  assert.equal(h.entries[0].data.screening.route, "fallback");
  assert.equal(JSON.stringify([h.notifications, h.entries]).includes("secret"), false);
});

test("English next survives ineligible inputs and bypass, then forces one Pi review on a JEV pass", async () => {
  const h = harness({ screen: async () => scores() });
  await h.commands.get("audit-english").handler("next", h.ctx);
  await h.commands.get("audit").handler("bypass-next", h.ctx);
  for (const event of [inputEvent(""), inputEvent("/skill:review"), inputEvent("steering", { streamingBehavior: "steer" }), inputEvent("internal", { source: "extension" })]) {
    assert.deepEqual(await h.input(event, h.ctx), { action: "continue" });
  }
  await h.input(inputEvent("Bypass this prompt"), h.ctx);
  assert.equal(h.screeningRequests.length, 0);
  await h.input(inputEvent("Polish this prompt", { streamingBehavior: "followUp" }), h.ctx);
  assert.equal(h.screeningRequests.length, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.entries.at(-1).data.screening.route, "english");
  await h.input(inputEvent("Regular prompt"), h.ctx);
  assert.equal(h.screeningRequests.length, 2);
  assert.equal(h.requests.length, 1);
});

test("dev and experiment force detailed reports even when JEV passes", async () => {
  for (const mode of ["dev", "experiment"]) {
    const h = harness({ screen: async () => scores() });
    await h.commands.get("audit").handler(mode, h.ctx);
    await h.input(inputEvent(), h.ctx);
    assert.equal(h.requests.length, 1);
    const raw = h.entries.find(entry => entry.customType === "prompt-audit-dev").data;
    assert.equal(raw.screening.route, mode);
    assert.equal(raw.screening.action, "PASS");
    assert.deepEqual(raw.normalizedReport, clearReport);
    assert.deepEqual(raw.auditorResponses, [JSON.stringify(clearReport)]);
  }
});

test("RPC has no review dialogs even when it advertises a UI", async () => {
  const h = harness({ reports: [ambiguousReport] });
  h.ctx.mode = "rpc";
  assert.deepEqual(await h.input(inputEvent(), h.ctx), { action: "continue" });
  assert.equal(h.requests.length, 1);
  assert.equal(h.selectionOptions.length, 0);
  assert.equal(h.entries[0].data.userAction, "headless-forwarded");
});

test("editing re-screens once and preserves edited text and images on a JEV pass", async () => {
  let calls = 0;
  const h = harness({
    screen: async () => scores(++calls === 1 ? { unsupported_capability: 0.99 } : {}),
    reports: [ambiguousReport], choices: [REVIEW_CHOICES.edit], edits: ["Use src/parser.ts"],
  });
  const images = [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }];
  assert.deepEqual(await h.input(inputEvent("Fix it", { images }), h.ctx), { action: "transform", text: "Use src/parser.ts", images });
  assert.equal(h.screeningRequests.length, 2);
  assert.equal(h.requests.length, 1);
  assert.equal(h.screeningRequests[1].envelope.prompt, "Use src/parser.ts");
  assert.deepEqual(h.entries.map(entry => entry.data.userAction), ["edited-and-reaudited", "passed"]);
});

test("cancel restores original text and never submits a generated revision", async () => {
  const h = harness({ reports: [ambiguousReport], choices: [REVIEW_CHOICES.cancel] });
  assert.deepEqual(await h.input(inputEvent("Fix it"), h.ctx), { action: "handled" });
  assert.deepEqual(h.restored, ["Fix it"]);
});

test("session reset aborts screening and prevents stale records or fallback calls", async () => {
  const pending = deferred();
  const started = deferred();
  const h = harness({ screen: async () => { started.resolve(); return pending.promise; } });
  const submission = h.input(inputEvent(), h.ctx);
  await started.promise;
  await h.emit("session_start");
  assert.equal(h.screeningRequests[0].signal.aborted, true);
  pending.resolve(scores({ missing_user_choice: 0.99 }));
  assert.deepEqual(await submission, { action: "handled" });
  assert.equal(h.entries.length, 0);
  assert.equal(h.requests.length, 0);
});

test("reset aborts an unresponsive Pi reviewer without waiting for its deadline", async () => {
  const started = deferred();
  const h = harness({ complete: async () => { started.resolve(); return new Promise(() => {}); } });
  const submission = h.input(inputEvent(), h.ctx);
  await started.promise;
  await h.emit("session_shutdown");
  assert.deepEqual(await submission, { action: "handled" });
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(h.entries.length, 0);
});

test("stale review selection cannot open an editor or apply a revision after tree navigation", async () => {
  const selected = deferred();
  const started = deferred();
  const h = harness({ reports: [ambiguousReport] });
  h.ctx.ui.select = async () => { started.resolve(); return selected.promise; };
  h.ctx.ui.editor = async () => { throw new Error("Stale editor must not open"); };
  const submission = h.input(inputEvent(), h.ctx);
  await started.promise;
  await h.emit("session_tree");
  selected.resolve(REVIEW_CHOICES.edit);
  assert.deepEqual(await submission, { action: "handled" });
  assert.equal(h.entries.length, 0);
  assert.equal(h.restored.length, 0);
});

test("an older screening cannot clear a newer request's status", async () => {
  const pending = [deferred(), deferred()];
  const started = [deferred(), deferred()];
  let calls = 0;
  const h = harness({ screen: async () => { const index = calls++; started[index].resolve(); return pending[index].promise; } });
  const first = h.input(inputEvent("First"), h.ctx);
  await started[0].promise;
  const second = h.input(inputEvent("Second"), h.ctx);
  await started[1].promise;
  const statusCount = h.statuses.length;
  pending[0].resolve(scores());
  assert.deepEqual(await first, { action: "handled" });
  assert.equal(h.statuses.length, statusCount);
  pending[1].resolve(scores());
  assert.deepEqual(await second, { action: "continue" });
  assert.equal(h.entries.length, 1);
});

test("standalone mode and rewrite settings neither enable auditing nor select the reviewer", async () => {
  const h = harness({
    auditEnabled: false,
    loadScreeningConfig: () => parseConfig({ mode: "review", rewrite: { model: "unused-model" } }),
  });
  await h.input(inputEvent(), h.ctx);
  assert.equal(h.screeningRequests.length, 0);
  await h.commands.get("audit").handler("on", h.ctx);
  h.flags.set("audit-model", "chosen/reviewer");
  const chosen = { ...h.ctx.model, provider: "chosen", id: "reviewer" };
  let actual;
  h.ctx.modelRegistry.find = (provider, id) => provider === "chosen" && id === "reviewer" ? chosen : undefined;
  const complete = h.ctx.modelRegistry.complete;
  h.ctx.modelRegistry.complete = async (model, ...args) => { actual = model; return complete(model, ...args); };
  await h.input(inputEvent(), h.ctx);
  assert.equal(actual, chosen);
});

test("absent real JEV credentials fall back before making any screening HTTP call", async () => {
  const key = "WASABI_MISSING_JEV_TEST_KEY";
  const previous = process.env[key];
  delete process.env[key];
  try {
    const h = harness({ screen: realScreen, loadScreeningConfig: () => parseConfig({ jev: { apiKeyEnv: key } }) });
    assert.deepEqual(await h.input(inputEvent(), h.ctx), { action: "continue" });
    assert.equal(h.requests.length, 1);
    assert.equal(h.entries[0].data.screening.route, "fallback");
  } finally {
    if (previous !== undefined) process.env[key] = previous;
  }
});

test("approved conventions reach the reviewer as evidence but never normal metadata", async () => {
  const convention = "Private convention: exports use CSV.";
  const h = harness({ loadScreeningConfig: () => parseConfig({ approvedConventions: [convention] }) });
  await h.input(inputEvent(), h.ctx);
  const content = h.requests[0].context.messages[0].content;
  assert.equal(content.at(-1).text.includes(convention), true);
  assert.equal(content.at(-1).text.includes("never severity or materiality"), true);
  assert.equal(JSON.stringify(h.entries).includes(convention), false);
  const record = h.entries[0].data;
  assert.deepEqual(record.screening.reviewer, { provider: "test-provider", modelId: "frontier-test" });
  assert.ok(record.screening.reviewLatencyMs >= 0);
});

test("diagnostic append failures do not turn a JEV pass into a reviewer call", async () => {
  const h = harness({ screen: async () => scores() });
  // The normal record uses a SHA-256 operation before appending. Rejecting it
  // exercises the same guarded diagnostics path without changing provider mocks.
  const original = globalThis.crypto.subtle.digest;
  globalThis.crypto.subtle.digest = async () => { throw new Error("unavailable diagnostics"); };
  try {
    assert.deepEqual(await h.input(inputEvent(), h.ctx), { action: "continue" });
    assert.equal(h.requests.length, 0);
    assert.equal(h.entries.length, 0);
  } finally {
    globalThis.crypto.subtle.digest = original;
  }
});

test("switching sessions during experiment navigation never starts its second branch", async () => {
  const h = harness({ reports: [ambiguousReport], choices: [REVIEW_CHOICES.apply] });
  await h.commands.get("audit").handler("experiment", h.ctx);
  await h.input(inputEvent("Fix it"), h.ctx);
  await h.emit("agent_settled");
  await new Promise(resolve => setTimeout(resolve, 0));
  const started = deferred();
  const pending = deferred();
  h.ctx.navigateTree = async () => { started.resolve(); return pending.promise; };
  const continuation = h.commands.get("audit").handler(h.sentUserMessages[0].content.slice("/audit ".length), h.ctx);
  await started.promise;
  await h.emit("session_start");
  pending.resolve({ cancelled: false });
  await continuation;
  assert.equal(h.sentUserMessages.length, 1);
  assert.equal(h.entries.filter(entry => entry.customType === "prompt-audit-experiment").length, 0);
});
