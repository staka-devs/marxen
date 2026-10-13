import { describe, expect, it } from "vitest";
import {
  addChatPermission,
  appendStreamingText,
  applyToolUpdate,
  cancelAssistant,
  cancelChatTools,
  createConversation,
  createStreamingAssistant,
  createUserMessage,
  dropTrailingFailedExchange,
  finalizeAssistant,
  isBusy,
  lastUserPrompt,
  retryHistory,
  setChatPlan,
  toHistoryPayload,
  upsertToolCall,
} from "./ai-conversation";
import type { PromptContext } from "../../contracts/ai-contracts";

/** Build a fixed prompt context fixture for conversation assertions. */
function context(): PromptContext {
  return { documentId: "doc_01", revision: 7, ranges: [{ start: 1, end: 3 }], text: "a😀日本語" };
}

describe("ai conversation", () => {
  it("creates isolated conversations with unique ids", () => {
    const first = createConversation();
    const second = createConversation();
    expect(first.id).not.toBe(second.id);
    expect(first.messages).toEqual([]);
  });

  it("carries only completed turns as bounded history", () => {
    const user = createUserMessage("1件目", "ask", [context()]);
    const assistant = { ...createStreamingAssistant(), text: "1件目の回答", state: "done" as const };
    const streaming = createStreamingAssistant();
    expect(toHistoryPayload([user, assistant, streaming])).toEqual([
      { role: "user", text: "1件目" },
      { role: "assistant", text: "1件目の回答" },
    ]);
    const many = Array.from({ length: 40 }, (_, index) => [
      createUserMessage(`q${index}`, "ask", []),
      { ...createStreamingAssistant(), text: `a${index}`, state: "done" as const },
    ]).flat();
    expect(toHistoryPayload(many)).toHaveLength(32);
    expect(toHistoryPayload(many)[0]).toEqual({ role: "user", text: "q24" });
  });

  it("drops cancelled exchanges so the next request stays clean", () => {
    const user = createUserMessage("質問", "ask", [context()]);
    const assistant = createStreamingAssistant();
    let messages = [user, assistant];
    messages = appendStreamingText(messages, assistant.id, "途中");
    expect(isBusy(messages)).toBe(true);
    messages = cancelAssistant(messages, assistant.id);
    expect(isBusy(messages)).toBe(false);
    expect(toHistoryPayload(messages)).toEqual([]);
    const cleaned = dropTrailingFailedExchange(messages);
    expect(cleaned).toHaveLength(0);
    // Retry resends the same prompt without duplicating the user turn.
    expect(lastUserPrompt(messages)).toMatchObject({ prompt: "質問", mode: "ask" });
    expect(retryHistory([user, ...cleaned.slice(1)])).toEqual([]);
  });

  it("finalizes streaming text into a done proposal", () => {
    const user = createUserMessage("書いて", "rewrite", [context()]);
    const assistant = createStreamingAssistant();
    let messages = [user, assistant];
    messages = appendStreamingText(messages, assistant.id, "こんにちは");
    messages = finalizeAssistant(
      messages,
      assistant.id,
      { text: "こんにちは世界", baseContexts: [{ documentId: "doc_01", revision: 7 }] },
      [{ documentId: "doc_01", revision: 7, ranges: [{ start: 1, end: 3 }], chars: 5 }],
    );
    expect(messages[1]).toMatchObject({ state: "done", text: "こんにちは世界" });
    expect(toHistoryPayload(messages)).toHaveLength(2);
  });

  it("orders real tool lifecycle without fabricating timelines", () => {
    const user = createUserMessage("直して", "workspace", [context()]);
    const assistant = createStreamingAssistant();
    let messages = [user, assistant];
    messages = upsertToolCall(messages, assistant.id, {
      toolCallId: "call_1",
      title: "Reading file",
      kind: "read",
      status: "pending",
    });
    expect(messages[1].tools).toHaveLength(1);
    messages = applyToolUpdate(messages, assistant.id, { toolCallId: "call_1", status: "in_progress" });
    expect(messages[1].tools?.[0]).toMatchObject({ status: "in_progress" });
    messages = applyToolUpdate(messages, assistant.id, { toolCallId: "call_1", status: "completed" });
    expect(messages[1].tools?.[0]).toMatchObject({ status: "completed" });
    // Unknown IDs never create phantom tools.
    messages = applyToolUpdate(messages, assistant.id, { toolCallId: "call_unknown", status: "completed" });
    expect(messages[1].tools).toHaveLength(1);
  });

  it("replaces plans completely and surfaces permission by actual ids", () => {
    const assistant = createStreamingAssistant();
    let messages = [assistant];
    messages = setChatPlan(messages, assistant.id, [
      { content: "Read", priority: "high", status: "pending" },
      { content: "Edit", priority: "high", status: "pending" },
    ]);
    expect(messages[0].plan).toHaveLength(2);
    messages = setChatPlan(messages, assistant.id, [
      { content: "Read", priority: "high", status: "completed" },
    ]);
    expect(messages[0].plan).toHaveLength(1);
    messages = addChatPermission(messages, assistant.id, {
      requestId: "900",
      toolCallId: "call_1",
      title: "mock tool",
      options: [
        { optionId: "mock_allow", name: "許可", kind: "allow_once" },
        { optionId: "mock_reject", name: "拒否", kind: "reject_once" },
      ],
    }, false);
    expect(messages[0].permissions?.[0]).toMatchObject({ requestId: "900", resolution: "denied" });
    expect(messages[0].permissions?.[0].options.map((option) => option.optionId)).toEqual(["mock_allow", "mock_reject"]);
  });

  it("settles unfinished tools once on cancellation", () => {
    const assistant = createStreamingAssistant();
    let messages = [assistant];
    messages = upsertToolCall(messages, assistant.id, {
      toolCallId: "call_1",
      title: "Edit",
      kind: "edit",
      status: "in_progress",
    });
    messages = upsertToolCall(messages, assistant.id, {
      toolCallId: "call_2",
      title: "Done",
      kind: "read",
      status: "completed",
    });
    messages = cancelChatTools(messages, assistant.id);
    expect(messages[0].tools?.find((tool) => tool.id === "call_1")).toMatchObject({ status: "cancelled" });
    expect(messages[0].tools?.find((tool) => tool.id === "call_2")).toMatchObject({ status: "completed" });
    messages = cancelAssistant([assistant], assistant.id);
    expect(messages[0].state).toBe("cancelled");
  });
});
