import { jest } from "@jest/globals";
import wasabi from "../wasabi.ts";

const active = "Wasabi · Private clarification · Main session paused";
const result = {
  missing_options: [{ id: "focus", question: "Which focus?",
    evidence: { message_index: 0, quote: "Speed or cost" }, available_choices: [
      { id: "speed", label: "Speed", evidence: { message_index: 0, quote: "Speed" } },
      { id: "cost", label: "Cost", evidence: { message_index: 0, quote: "cost" } },
    ] }], recommended_combination: [{ option_id: "focus", choice_id: "speed" }],
};

function harness(actions: (string | undefined)[] = []) {
  const events: Record<string, any> = {};
  const commands: Record<string, any> = {};
  let status: string | undefined;
  const ctx: any = {
    hasUI: true,
    sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "Speed or cost" } }] },
    modelRegistry: { getAvailable: () => [{ provider: "p", id: "light" }],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }) },
    ui: {
      setStatus: jest.fn((_key: string, text: string | undefined) => { status = text; }),
      select: jest.fn<any>(async (title: string) => {
        expect(status).toBe(active);
        expect(title).toContain("Wasabi");
        return actions.shift();
      }),
      editor: jest.fn<any>(async (title: string) => {
        expect(status).toBe(active);
        expect(title).toContain("Wasabi");
        return "Edited prompt";
      }), notify: jest.fn(),
    },
  };
  const invoke = jest.fn<any>(async () => {
    expect(status).toBe(active);
    return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify(result) }] };
  });
  wasabi({ on: (name: string, handler: any) => { events[name] = handler; },
    registerCommand: (name: string, command: any) => { commands[name] = command; },
    appendEntry: jest.fn(),
  } as any, invoke);
  return { ctx, invoke, commands, status: () => status,
    input: () => events.input({ source: "interactive", text: "Compare them" }, ctx) };
}

test.each([
  ["approval", ["Confirm recommended combination", "Edit final prompt", "Approve and send"], "transform"],
  ["question cancellation", ["Cancel request"], "handled"],
  ["question dismissal", [undefined], "handled"],
  ["review cancellation", ["Finish clarification and review prompt", "Cancel request"], "handled"],
] as const)("Wasabi is identified throughout private UI and cleared after %s", async (_name, actions, expected) => {
  const h = harness([...actions]);
  await h.commands["wasabi-model"].handler("p/light", h.ctx);
  expect((await h.input()).action).toBe(expected);
  expect(h.ctx.ui.setStatus.mock.calls).toEqual([["wasabi", active], ["wasabi", undefined]]);
  expect(h.status()).toBeUndefined();
});

test.each(["checker failure", "dialog failure", "no missing options"])("clears Wasabi status on %s", async mode => {
  const h = harness();
  await h.commands["wasabi-model"].handler("p/light", h.ctx);
  if (mode === "checker failure") h.invoke.mockRejectedValueOnce(new Error("Unavailable"));
  if (mode === "dialog failure") h.ctx.ui.select.mockRejectedValueOnce(new Error("Closed"));
  if (mode === "no missing options") h.invoke.mockResolvedValueOnce({ stopReason: "stop", content: [
    { type: "text", text: JSON.stringify({ missing_options: [], recommended_combination: [] }) },
  ] });
  expect((await h.input()).action).toBe(mode === "no missing options" ? "continue" : "handled");
  expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("wasabi", undefined);
  expect(h.status()).toBeUndefined();
});

test("disabled and headless inputs do not install a UI indicator", async () => {
  const h = harness();
  await h.commands.wasabi.handler("off", h.ctx);
  expect((await h.input()).action).toBe("continue");
  expect(h.ctx.ui.setStatus).not.toHaveBeenCalled();
  await h.commands["wasabi-model"].handler("p/light", h.ctx);
  await h.commands.wasabi.handler("on", h.ctx);
  h.ctx.hasUI = false;
  h.invoke.mockResolvedValueOnce({ stopReason: "stop", content: [
    { type: "text", text: JSON.stringify(result) },
  ] });
  expect((await h.input()).action).toBe("handled");
  expect(h.ctx.ui.setStatus).not.toHaveBeenCalled();
});
