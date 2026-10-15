import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AiPanel from "./ai-panel";
import { setCredential, testConnection } from "../infrastructure/tauri/ai-client";
import type { AiStreamEvent, PromptContext, StagingTarget } from "../contracts/ai-contracts";
import type { AiGateway } from "../application/ports";

const mockStartPrompt = vi.fn<AiGateway["startPrompt"]>();

vi.mock("./ai-provider-settings", async (importOriginal) => ({
  ...await importOriginal<typeof import("./ai-provider-settings")>(),
  /** Mocked settings subview for chat tests. */
  default: () => <div>接続設定 mock</div>,
}));
beforeEach(() => {
  vi.resetAllMocks();
  mockStartPrompt.mockReset();
  window.localStorage.clear();
});

const contexts: PromptContext[] = [
  { documentId: "doc_01", revision: 7, ranges: [{ start: 1, end: 3 }], text: "a😀日本語" },
];
const staging: StagingTarget = { copyId: "copy_01" };
const labels = { doc_01: "a.md" };

/** Emit stream events synchronously into a captured handler for assertions. */ function emit(events: AiStreamEvent[], handler: (event: AiStreamEvent) => void) {
  for (const event of events) {
    handler(event);
  }
}

/** Create a deferred promise for gating staging and start flows in tests. */ function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("agent chat", () => {
  it("keeps a completed conversation on its original root and requires a new chat after a switch", async () => {
    const first = { ...contexts[0], location: { scope: { rootId: "root-a", generation: "1" }, path: "same.md", position: 0 } };
    const second = { ...contexts[0], documentId: "doc-b", location: { scope: { rootId: "root-b", generation: "2" }, path: "same.md", position: 0 } };
    mockStartPrompt.mockImplementation(async (_request, onEvent) => {
      onEvent({ type: "done", payload: { runId: "owned-chat", proposal: { text: "answer", baseContexts: [] }, sent: [] } });
      return {
        runId: "owned-chat",
        /** Stop the already completed mock run. */
        stop: async () => undefined,
      };
    });
    const { rerender } = render(<AiPanel startPrompt={mockStartPrompt} contexts={[first]} staging={staging} />);
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "first question" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await vi.waitFor(() => expect(mockStartPrompt).toHaveBeenCalledOnce());
    const conversationId = mockStartPrompt.mock.calls[0][0].conversationId;
    expect(conversationId).toBeTruthy();
    rerender(<AiPanel startPrompt={mockStartPrompt} contexts={[second]} staging={staging} />);
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "second question" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(await screen.findByText(/既存の会話は元のフォルダー/)).toBeVisible();
    expect(mockStartPrompt).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "新しい会話" }));
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "new root question" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await vi.waitFor(() => expect(mockStartPrompt).toHaveBeenCalledTimes(2));
    expect(mockStartPrompt.mock.calls[1][0].conversationId).not.toBe(conversationId);
  });
  it("does not publish a done event that races with cancellation", async () => {
    let handler!: (event: AiStreamEvent) => void;
    /** Owned stop handle recording cancellation. */
    const stop = vi.fn(async () => undefined);
    const onProposal = vi.fn();
    const onBusyChange = vi.fn();
    mockStartPrompt.mockImplementation(async (_request, onEvent) => {
      handler = onEvent;
      return { runId: "cancel-race", stop };
    });
    render(<AiPanel startPrompt={mockStartPrompt} contexts={contexts} staging={staging} onProposal={onProposal} onBusyChange={onBusyChange} />);
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "停止する" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await vi.waitFor(() => expect(mockStartPrompt).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "取り消し" }));
    handler({ type: "usage", payload: { runId: "cancel-race", usage: { provider: "acp", preset: "codex", runId: "cancel-race", sessionId: "session", source: "usage_update", scope: "session", used: 25, size: 100, receivedMs: 1 } } });
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    expect(screen.queryByText("取り消しました。")).not.toBeInTheDocument();
    handler({ type: "done", payload: { runId: "cancel-race", proposal: { text: "遅い回答", baseContexts: [] }, sent: [] } });
    expect(await screen.findByText("取り消しました。")).toBeVisible();
    expect(onProposal).not.toHaveBeenCalled();
    expect(screen.queryByText("遅い回答")).not.toBeInTheDocument();
  });

  it("keeps a new draft when an old preparation resolves after changing conversation", async () => {
    const gate = deferred<StagingTarget>();
    render(<AiPanel startPrompt={mockStartPrompt} contexts={contexts} staging={null} ensureStaging={() => gate.promise} />);
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "古い入力" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    fireEvent.click(screen.getByRole("button", { name: "新しい会話" }));
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "新しい下書き" } });
    gate.resolve(staging);
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "送信" })).toBeEnabled());
    expect(screen.getByLabelText("プロンプト")).toHaveValue("新しい下書き");
    expect(mockStartPrompt).not.toHaveBeenCalled();
    expect(screen.queryByText("古い入力")).not.toBeInTheDocument();
  });

  it("starts a fresh conversation when the controlled endpoint changes", async () => {
    let handler!: (event: AiStreamEvent) => void;
    const first = { kind: "openai_compatible", acp: null, anthropic: null, openai: { endpoint: "http://localhost:9001/v1", model: "first" } } as const;
    const second = { ...first, openai: { endpoint: "http://localhost:9002/v1", model: "second" } };
    mockStartPrompt.mockImplementation(async (_request, onEvent) => {
      handler = onEvent;
      return { runId: "provider", stop: vi.fn() };
    });
    const { rerender } = render(<AiPanel startPrompt={mockStartPrompt} contexts={contexts} staging={staging} provider={first} />);
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "最初の会話" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await vi.waitFor(() => expect(mockStartPrompt).toHaveBeenCalled());
    handler({ type: "done", payload: { runId: "provider", proposal: { text: "最初の応答", baseContexts: [] }, sent: [] } });
    await screen.findByText("最初の応答");
    rerender(<AiPanel startPrompt={mockStartPrompt} contexts={contexts} staging={staging} provider={second} />);
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "別の接続先" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await vi.waitFor(() => expect(mockStartPrompt).toHaveBeenCalledTimes(2));
    expect(mockStartPrompt.mock.calls[1][0].history).toEqual([]);
    expect(mockStartPrompt.mock.calls[1][0].provider).toEqual(second);
  });
  it("shows filename chips and auto-registers on send without internal ids", async () => {
    let handler: ((event: AiStreamEvent) => void) | null = null;
    mockStartPrompt.mockImplementation(async (_request, onEvent) => {
      handler = onEvent;
      return { runId: "run_1", stop: vi.fn() };
    });
    /** Staging resolver returning the fixed copy. */
    const ensureStaging = vi.fn(async () => staging);
    render(<AiPanel startPrompt={mockStartPrompt} contexts={contexts} staging={null} ensureStaging={ensureStaging} contextLabels={labels} />);
    expect(screen.getByText("a.md")).toBeVisible();
    expect(screen.queryByText(/doc_01/)).not.toBeInTheDocument();
    expect(screen.queryByText(/copy_01/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "質問です" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await vi.waitFor(() => expect(ensureStaging).toHaveBeenCalled());
    await vi.waitFor(() => expect(mockStartPrompt).toHaveBeenCalled());
    expect(mockStartPrompt.mock.calls[0][0]).toMatchObject({
      staging,
      prompt: "質問です",
      history: [],
    });
    emit(
      [
        { type: "started", payload: { runId: "run_1" } },
        { type: "chunk", payload: { runId: "run_1", text: "こんにちは" } },
        {
          type: "done",
          payload: {
            runId: "run_1",
            proposal: { text: "こんにちは世界", baseContexts: [{ documentId: "doc_01", revision: 7 }] },
            sent: [{ documentId: "doc_01", revision: 7, ranges: [{ start: 1, end: 3 }], chars: 5 }],
          },
        },
      ],
      handler!,
    );
    expect(await screen.findByText("こんにちは世界")).toBeVisible();
    expect(screen.queryByText(/doc_01/)).not.toBeInTheDocument();
  });

  it("validates exact contexts through ensure even when a staging prop exists", async () => {
    /** Staging resolver returning the fixed copy. */
    const ensureStaging = vi.fn(async () => staging);
    mockStartPrompt.mockImplementation(async () => {
      return { runId: "run_x", stop: vi.fn() };
    });
    render(<AiPanel startPrompt={mockStartPrompt} contexts={contexts} staging={staging} ensureStaging={ensureStaging} contextLabels={labels} />);
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "質問" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await vi.waitFor(() => expect(ensureStaging).toHaveBeenCalledWith(contexts));
  });

  it("sends the second turn with explicit two-turn history", async () => {
    const handlers: Array<(event: AiStreamEvent) => void> = [];
    mockStartPrompt.mockImplementation(async (_request, onEvent) => {
      handlers.push(onEvent);
      return { runId: `run_${handlers.length}`, stop: vi.fn() };
    });
    render(<AiPanel startPrompt={mockStartPrompt} contexts={contexts} staging={staging} contextLabels={labels} />);
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "1件目" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await vi.waitFor(() => expect(handlers.length).toBe(1));
    emit(
      [
        { type: "started", payload: { runId: "run_1" } },
        {
          type: "done",
          payload: {
            runId: "run_1",
            proposal: { text: "回答1", baseContexts: [{ documentId: "doc_01", revision: 7 }] },
            sent: [{ documentId: "doc_01", revision: 7, ranges: [{ start: 1, end: 3 }], chars: 5 }],
          },
        },
      ],
      handlers[0],
    );
    expect(await screen.findByText("回答1")).toBeVisible();
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "2件目" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await vi.waitFor(() => expect(handlers.length).toBe(2));
    const second = mockStartPrompt.mock.calls[1][0];
    expect(second.prompt).toBe("2件目");
    expect(second.history).toEqual([
      { role: "user", text: "1件目" },
      { role: "assistant", text: "回答1" },
    ]);
  });

  it("keeps prior conversations in the selector instead of destroying them", async () => {
    let handler: ((event: AiStreamEvent) => void) | null = null;
    mockStartPrompt.mockImplementation(async (_request, onEvent) => {
      handler = onEvent;
      return { runId: "run_1", stop: vi.fn() };
    });
    render(<AiPanel startPrompt={mockStartPrompt} contexts={contexts} staging={staging} contextLabels={labels} />);
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "質問" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await vi.waitFor(() => expect(handler).not.toBeNull());
    emit(
      [
        { type: "started", payload: { runId: "run_1" } },
        {
          type: "done",
          payload: {
            runId: "run_1",
            proposal: { text: "回答", baseContexts: [{ documentId: "doc_01", revision: 7 }] },
            sent: [{ documentId: "doc_01", revision: 7, ranges: [{ start: 1, end: 3 }], chars: 5 }],
          },
        },
      ],
      handler!,
    );
    expect(await screen.findByText("回答")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "新しい会話" }));
    expect(screen.queryByText("回答")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "履歴を開く" }));
    expect(screen.getByRole("searchbox", { name: "履歴を検索" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: /質問/ }));
    expect(await screen.findByText("回答")).toBeVisible();
    // The fresh conversation starts with empty history.
    fireEvent.click(screen.getByRole("button", { name: "新しい会話" }));
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "別件" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await vi.waitFor(() => expect(mockStartPrompt).toHaveBeenCalledTimes(2));
    expect(mockStartPrompt.mock.calls[1][0].history).toEqual([]);
  });

  it("cancels without persisting the failed turn and retries the same prompt", async () => {
    let handler: ((event: AiStreamEvent) => void) | null = null;
    mockStartPrompt.mockImplementation(async (_request, onEvent) => {
      handler = onEvent;
      return { runId: "run_1", stop: vi.fn() };
    });
    render(<AiPanel startPrompt={mockStartPrompt} contexts={contexts} staging={staging} contextLabels={labels} />);
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "書いて" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await vi.waitFor(() => expect(handler).not.toBeNull());
    emit([{ type: "started", payload: { runId: "run_1" } }], handler!);
    expect(await screen.findByRole("button", { name: "取り消し" })).toBeVisible();
    emit([{ type: "cancelled", payload: { runId: "run_1" } }], handler!);
    expect(await screen.findByText("取り消しました。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    await vi.waitFor(() => expect(mockStartPrompt).toHaveBeenCalledTimes(2));
    const retry = mockStartPrompt.mock.calls[1][0];
    expect(retry.prompt).toBe("書いて");
    expect(retry.history).toEqual([]);
  });

  it("cancels while staging is pending and never starts the run", async () => {
    const gate = deferred<StagingTarget>();
    /** Staging resolver gated on the deferred copy. */
    const ensureStaging = vi.fn(() => gate.promise);
    mockStartPrompt.mockImplementation(async () => {
      return { runId: "run_late", stop: vi.fn() };
    });
    render(<AiPanel startPrompt={mockStartPrompt} contexts={contexts} staging={null} ensureStaging={ensureStaging} contextLabels={labels} />);
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "待って" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await vi.waitFor(() => expect(ensureStaging).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "取り消し" }));
    gate.resolve(staging);
    expect(await screen.findByText("取り消しました。")).toBeVisible();
    expect(mockStartPrompt).not.toHaveBeenCalled();
  });

  it("cancels the late handle when done arrives before startPrompt returns", async () => {
    /** Owned stop handle recording cancellation. */
    const stop = vi.fn(async () => undefined);
    const onProposal = vi.fn();
    mockStartPrompt.mockImplementation(async (_request, onEvent) => {
      onEvent({ type: "started", payload: { runId: "run_race" } });
      onEvent({
        type: "done",
        payload: {
          runId: "run_race",
          proposal: { text: "早い回答", baseContexts: [{ documentId: "doc_01", revision: 7 }] },
          sent: [{ documentId: "doc_01", revision: 7, ranges: [{ start: 1, end: 3 }], chars: 5 }],
        },
      });
      return { runId: "run_race", stop };
    });
    render(<AiPanel startPrompt={mockStartPrompt} contexts={contexts} staging={staging} contextLabels={labels} onProposal={onProposal} />);
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "質問" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(await screen.findByText("早い回答")).toBeVisible();
    // The late handle is cancelled on settlement so nothing leaks.
    await vi.waitFor(() => expect(stop).toHaveBeenCalled());
    // No spinner remains and the proposal published exactly once.
    expect(screen.queryByText("応答を生成しています…")).not.toBeInTheDocument();
    expect(onProposal).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "取り消し" })).not.toBeInTheDocument();
  });

  it("fences the old run on reset so late events never publish", async () => {
    /** Deferred session coupling run ID with its stop handle. */
    const gate = deferred<{
      runId: string;
      /** Owned stop handle for the deferred session. */
      stop: () => Promise<void>;
    }>();
    const onProposal = vi.fn();
    mockStartPrompt.mockImplementation(async (_request, onEvent) => {
      const session = await gate.promise;
      // Late done for the fenced run.
      onEvent({
        type: "done",
        payload: {
          runId: "run_old",
          proposal: { text: "古い回答", baseContexts: [{ documentId: "doc_01", revision: 7 }] },
          sent: [{ documentId: "doc_01", revision: 7, ranges: [{ start: 1, end: 3 }], chars: 5 }],
        },
      });
      return session;
    });
    render(<AiPanel startPrompt={mockStartPrompt} contexts={contexts} staging={staging} contextLabels={labels} onProposal={onProposal} />);
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "最初" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await vi.waitFor(() => expect(mockStartPrompt).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "新しい会話" }));
    gate.resolve({
      runId: "run_old",
      /** Owned stop handle for the fenced run. */
      stop: vi.fn(async () => undefined),
    });
    await vi.waitFor(() => expect(mockStartPrompt).toHaveBeenCalled());
    expect(screen.queryByText("古い回答")).not.toBeInTheDocument();
    expect(onProposal).not.toHaveBeenCalled();
  });

  it("cancels the owned run on unmount", async () => {
    /** Deferred session coupling run ID with its stop handle. */
    const gate = deferred<{
      runId: string;
      /** Owned stop handle for the deferred session. */
      stop: () => Promise<void>;
    }>();
    /** Owned stop handle recording cancellation. */
    const stop = vi.fn(async () => undefined);
    mockStartPrompt.mockImplementation(async () => gate.promise.then(() => ({ runId: "run_u", stop })));
    const { unmount } = render(<AiPanel startPrompt={mockStartPrompt} contexts={contexts} staging={staging} contextLabels={labels} />);
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "質問" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await vi.waitFor(() => expect(mockStartPrompt).toHaveBeenCalled());
    unmount();
    gate.resolve({ runId: "run_u", stop });
    await vi.waitFor(() => expect(stop).toHaveBeenCalled());
  });

  it("offers every prompt mode in the unified mode selector", () => {
    render(<AiPanel startPrompt={mockStartPrompt} contexts={contexts} staging={staging} contextLabels={labels} />);
    expect(screen.getByRole("group", { name: "プロンプトの種類" })).toBeVisible();
    fireEvent.click(screen.getByRole("combobox", { name: "モード" }));
    for (const label of ["相談", "執筆", "推敲", "文書編集"]) expect(screen.getByRole("option", { name: new RegExp(label) })).toBeVisible();
  });

  it("closes the pane through the optional header control", () => {
    const onClose = vi.fn();
    const { rerender } = render(<AiPanel startPrompt={mockStartPrompt} contexts={contexts} staging={staging} contextLabels={labels} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "チャットを閉じる" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<AiPanel startPrompt={mockStartPrompt} contexts={contexts} staging={staging} contextLabels={labels} />);
    expect(screen.queryByRole("button", { name: "チャットを閉じる" })).not.toBeInTheDocument();
  });

  it("locks the mode during a run and reports the captured mode", async () => {
    let handler: ((event: AiStreamEvent) => void) | null = null;
    const onProposal = vi.fn();
    mockStartPrompt.mockImplementation(async (request, onEvent) => {
      expect(request.mode).toBe("rewrite");
      handler = onEvent;
      return { runId: "run_m", stop: vi.fn() };
    });
    render(<AiPanel startPrompt={mockStartPrompt} contexts={contexts} staging={staging} contextLabels={labels} onProposal={onProposal} />);
    fireEvent.click(screen.getByRole("combobox", { name: "モード" }));
    fireEvent.click(screen.getByRole("option", { name: /推敲/ }));
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "書いて" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await vi.waitFor(() => expect(handler).not.toBeNull());
    expect(screen.getByRole("combobox", { name: "モード" })).toBeDisabled();
    handler!({
      type: "done",
      payload: {
        runId: "run_m",
        proposal: { text: "案", baseContexts: [{ documentId: "doc_01", revision: 7 }] },
        sent: [{ documentId: "doc_01", revision: 7, ranges: [{ start: 1, end: 3 }], chars: 5 }],
      },
    });
    await vi.waitFor(() => expect(onProposal).toHaveBeenCalled());
    expect(onProposal.mock.calls[0][2]).toBe("rewrite");
  });

  it("stays fenced while the inline chat owns a run", () => {
    render(<AiPanel startPrompt={mockStartPrompt} contexts={contexts} staging={staging} contextLabels={labels} disabled />);
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "質問" } });
    expect(screen.getByRole("button", { name: "送信" })).toBeDisabled();
    expect(screen.getByText("他の応答を生成しています。")).toBeVisible();
  });

  it("shows stream errors as alerts with retry", async () => {
    mockStartPrompt.mockImplementation(async (_request, onEvent) => {
      onEvent({ type: "error", payload: { runId: "run_2", error: { code: "auth_failed", detail: "bad key" } } });
      return { runId: "run_2", stop: vi.fn() };
    });
    render(<AiPanel startPrompt={mockStartPrompt} contexts={contexts} staging={staging} contextLabels={labels} />);
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "質問" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("認証に失敗しました");
    expect(screen.getByRole("button", { name: "再試行" })).toBeEnabled();
  });

  it("preserves stale base revisions for review without internal ids", async () => {
    const seen: Array<string> = [];
    mockStartPrompt.mockImplementation(async (_request, onEvent) => {
      onEvent({ type: "started", payload: { runId: "run_9" } });
      onEvent({
        type: "done",
        payload: {
          runId: "run_9",
          proposal: { text: "古い基準の提案", baseContexts: [{ documentId: "doc_01", revision: 6 }] },
          sent: [{ documentId: "doc_01", revision: 6, ranges: [{ start: 1, end: 3 }], chars: 5 }],
        },
      });
      return { runId: "run_9", stop: vi.fn() };
    });
    render(
      <AiPanel
        startPrompt={mockStartPrompt}
        contexts={contexts}
        staging={staging}
        contextLabels={labels}
        onProposal={(proposal) => seen.push(proposal.text)}
      />,
    );
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "書いて" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(await screen.findByText("古い基準の提案")).toBeVisible();
    expect(screen.queryByText(/doc_01/)).not.toBeInTheDocument();
    expect(seen).toEqual(["古い基準の提案"]);
  });

  it("blocks sending while staging is unresolved and reports it", async () => {
    render(<AiPanel startPrompt={mockStartPrompt} contexts={contexts} staging={null} contextLabels={labels} />);
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "質問" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/作業コピー/);
    expect(mockStartPrompt).not.toHaveBeenCalled();
  });

  it("keeps credential helpers available without displaying values", async () => {
    const { default: Settings } = await import("./ai-provider-settings");
    expect(Settings).toBeDefined();
    expect(setCredential).toBeDefined();
    expect(testConnection).toBeDefined();
  });

  it("fills the composer when an empty-chat example is clicked", () => {
    render(<AiPanel startPrompt={mockStartPrompt} contexts={contexts} staging={staging} contextLabels={labels} />);
    expect(screen.getByLabelText("プロンプト")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "この文書の要点を3行で教えてください。" }));
    expect(screen.getByLabelText("プロンプト")).toHaveValue("この文書の要点を3行で教えてください。");
    expect(mockStartPrompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "選択範囲を読みやすく書き直してください。" }));
    expect(screen.getByLabelText("プロンプト")).toHaveValue("選択範囲を読みやすく書き直してください。");
  });

  it("shows quiet dividers without fake connection success", () => {
    render(<AiPanel startPrompt={mockStartPrompt} contexts={contexts} staging={staging} contextLabels={labels} />);
    expect(screen.queryByText(/接続済み|接続成功/)).not.toBeInTheDocument();
    expect(screen.getByText("a.md")).toBeVisible();
  });

  it("renders injected model controls without inventing model lists", () => {
    render(<AiPanel startPrompt={mockStartPrompt} contexts={contexts} staging={staging} contextLabels={labels} modelControls={<div>モデル切替</div>} />);
    expect(screen.getByText("モデル切替")).toBeVisible();
    expect(mockStartPrompt).not.toHaveBeenCalled();
  });

  it("hides the model slot when no controls are injected", () => {
    const { container } = render(<AiPanel startPrompt={mockStartPrompt} contexts={contexts} staging={staging} contextLabels={labels} />);
    expect(container.querySelector(".ai-chat-model-slot")).toBeNull();
  });
});





