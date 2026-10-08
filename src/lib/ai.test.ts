import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import openaiSse from "../../tests/fixtures/ai_sse_openai.txt?raw";
import anthropicSse from "../../tests/fixtures/ai_sse_anthropic.txt?raw";
import {
  AI_STREAM_EVENT,
  defaultProviderConfig,
  describeAiError,
  describeInvokeError,
  isClaudeCommand,
  startPrompt,
  summarizeContext,
  testConnection,
} from "./ai";
import type {
  AiError,
  AiPromptRequest,
  AiStreamEvent,
  PromptContext,
} from "../shared/ai-contracts";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

function sseDataPayloads(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());
}

describe("ai transport", () => {
  it("builds kind-matched provider configs with opt-in Anthropic", () => {
    expect(defaultProviderConfig("acp")).toEqual({
      kind: "acp",
      acp: { preset: "codex", argv: null },
      openai: null,
      anthropic: null,
    });
    const openai = defaultProviderConfig("openai_compatible");
    expect(openai.openai?.endpoint).toContain("https://");
    const anthropic = defaultProviderConfig("anthropic");
    expect(anthropic.anthropic?.enabled).toBe(false);
  });

  it("refuses claude commands like the Rust validator", () => {
    for (const command of ["claude", "CLAUDE.EXE", "claude-code", "/usr/bin/claude"]) {
      expect(isClaudeCommand(command)).toBe(true);
    }
    for (const command of ["codex", "opencode", "my-agent", "claudette"]) {
      expect(isClaudeCommand(command)).toBe(false);
    }
  });

  it("summarizes the exact sent scope of a context", () => {
    const context: PromptContext = {
      documentId: "doc_01",
      revision: 7,
      ranges: [{ start: 1, end: 3 }],
      text: "a😀日本語",
    };
    expect(summarizeContext(context)).toBe("doc_01 rev 7 [1, 3) 5文字");
  });

  it("describes every error code in Japanese", () => {
    const cases: AiError[] = [
      { code: "invalid_config", detail: "d" },
      { code: "missing_credentials", provider: "anthropic" },
      { code: "missing_binary", command: "codex" },
      { code: "spawn_failed", detail: "d" },
      { code: "connection_failed", detail: "d" },
      { code: "auth_failed", detail: "d" },
      { code: "stream_failed", detail: "d" },
      { code: "request_cancelled" },
      { code: "session_required" },
      { code: "session_busy" },
      { code: "unknown_session" },
      { code: "staging_unresolved", copy_id: "copy_1" },
      { code: "live_target_rejected", detail: "d" },
      { code: "unsupported_protocol", version: 2 },
      { code: "claude_code_refused", command: "claude" },
      { code: "credential_store_failed", detail: "d" },
    ];
    for (const error of cases) {
      const message = describeAiError(error);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("undefined");
    }
    expect(describeAiError({ code: "missing_binary", command: "codex" })).toContain("codex");
    expect(describeInvokeError({ code: "session_busy" })).toContain("実行中");
    expect(describeInvokeError(new Error("boom"))).toBe("boom");
  });

  it("refuses Tauri commands in the browser without invoking IPC", async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    await expect(testConnection(defaultProviderConfig("acp"), false)).rejects.toThrow(
      "デスクトップアプリ",
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it("routes stream events by run id and cancels through IPC", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const captured: { handler?: (event: { payload: AiStreamEvent }) => void } = {};
    const unlisten = vi.fn();
    vi.mocked(listen).mockImplementation(async (_event, callback) => {
      captured.handler = callback as (event: { payload: AiStreamEvent }) => void;
      return unlisten;
    });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "ai_prompt_stream") {
        return "run_9";
      }
      return null;
    });
    const seen: AiStreamEvent[] = [];
    const request = {
      provider: defaultProviderConfig("acp"),
      mode: "ask",
      prompt: "質問",
      contexts: [],
      staging: { copyId: "copy_1" },
      sessionId: null,
      history: [],
    } as AiPromptRequest;
    const session = await startPrompt(request, (event) => seen.push(event));
    expect(session.runId).toBe("run_9");
    expect(listen).toHaveBeenCalledWith(AI_STREAM_EVENT, expect.any(Function));
    expect(invoke).toHaveBeenCalledWith("ai_prompt_stream", { request });

    captured.handler?.({ payload: { type: "chunk", payload: { runId: "run_other", text: "x" } } });
    captured.handler?.({ payload: { type: "chunk", payload: { runId: "run_9", text: "あ" } } });
    expect(seen).toEqual([{ type: "chunk", payload: { runId: "run_9", text: "あ" } }]);

    await session.stop();
    expect(invoke).toHaveBeenCalledWith("ai_prompt_cancel", { runId: "run_9" });
    expect(unlisten).toHaveBeenCalled();
  });

  it("shares the SSE wire fixtures with the Rust integration tests", () => {
    const openaiTexts: string[] = [];
    let openaiDone = false;
    for (const data of sseDataPayloads(openaiSse)) {
      if (data === "[DONE]") {
        openaiDone = true;
        continue;
      }
      const content = JSON.parse(data).choices[0].delta.content;
      if (typeof content === "string" && content.length > 0) {
        openaiTexts.push(content);
      }
    }
    expect(openaiTexts.join("")).toBe("Hello, 世界！");
    expect(openaiDone).toBe(true);

    const anthropicTexts: string[] = [];
    let anthropicEnd = false;
    for (const data of sseDataPayloads(anthropicSse)) {
      const envelope = JSON.parse(data);
      if (envelope.type === "message_stop") {
        anthropicEnd = true;
      }
      if (envelope.type === "content_block_delta" && envelope.delta?.type === "text_delta") {
        anthropicTexts.push(envelope.delta.text);
      }
    }
    expect(anthropicTexts.join("")).toBe("Hello, 世界！");
    expect(anthropicEnd).toBe(true);
  });

  it("keeps the done event wire shape with camelCase run ids", () => {
    const event: AiStreamEvent = {
      type: "done",
      payload: {
        runId: "run_1",
        proposal: { text: "案", baseContexts: [{ documentId: "doc_01", revision: 7 }] },
        sent: [{ documentId: "doc_01", revision: 7, ranges: [{ start: 1, end: 3 }], chars: 5 }],
      },
    };
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });
});
