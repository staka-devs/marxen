import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AiPanel from "./ai-panel";
import {
  getCredentialState,
  setCredential,
  startPrompt,
  testConnection,
} from "../lib/ai";
import type { AiStreamEvent, PromptContext, StagingTarget } from "../shared/ai-contracts";

vi.mock("../lib/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ai")>();
  return {
    ...actual,
    getCredentialState: vi.fn(),
    setCredential: vi.fn(),
    deleteCredential: vi.fn(),
    testConnection: vi.fn(),
    startPrompt: vi.fn(),
    cancelPromptSafe: vi.fn(),
  };
});
vi.mock("./ai-provider-settings", () => ({
  default: () => <div>接続設定 mock</div>,
}));
beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
});

const contexts: PromptContext[] = [
  { documentId: "doc_01", revision: 7, ranges: [{ start: 1, end: 3 }], text: "a😀日本語" },
];
const staging: StagingTarget = { copyId: "copy_01" };

function emit(events: AiStreamEvent[], handler: (event: AiStreamEvent) => void) {
  for (const event of events) {
    handler(event);
  }
}

describe("agent chat", () => {
  it("shows the exact sent scope as chips and auto-registers on send", async () => {
    let handler: ((event: AiStreamEvent) => void) | null = null;
    vi.mocked(startPrompt).mockImplementation(async (_request, onEvent) => {
      handler = onEvent;
      return { runId: "run_1", stop: vi.fn() };
    });
    const ensureStaging = vi.fn(async () => staging);
    render(<AiPanel contexts={contexts} staging={null} ensureStaging={ensureStaging} />);
    expect(screen.getByText("doc_01 rev 7 [1, 3) 5文字")).toBeVisible();
    expect(screen.getByText(/自動登録/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "質問です" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await vi.waitFor(() => expect(ensureStaging).toHaveBeenCalled());
    await vi.waitFor(() => expect(vi.mocked(startPrompt)).toHaveBeenCalled());
    expect(vi.mocked(startPrompt).mock.calls[0][0]).toMatchObject({
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
    expect(screen.getAllByText(/doc_01 rev 7/).length).toBeGreaterThanOrEqual(2);
  });

  it("sends the second turn with explicit two-turn history", async () => {
    const handlers: Array<(event: AiStreamEvent) => void> = [];
    vi.mocked(startPrompt).mockImplementation(async (_request, onEvent) => {
      handlers.push(onEvent);
      return { runId: `run_${handlers.length}`, stop: vi.fn() };
    });
    render(<AiPanel contexts={contexts} staging={staging} />);
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
    const second = vi.mocked(startPrompt).mock.calls[1][0];
    expect(second.prompt).toBe("2件目");
    expect(second.history).toEqual([
      { role: "user", text: "1件目" },
      { role: "assistant", text: "回答1" },
    ]);
  });

  it("starts an isolated new conversation on demand", async () => {
    let handler: ((event: AiStreamEvent) => void) | null = null;
    vi.mocked(startPrompt).mockImplementation(async (_request, onEvent) => {
      handler = onEvent;
      return { runId: "run_1", stop: vi.fn() };
    });
    render(<AiPanel contexts={contexts} staging={staging} />);
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
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "別件" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await vi.waitFor(() => expect(vi.mocked(startPrompt)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(startPrompt).mock.calls[1][0].history).toEqual([]);
  });

  it("cancels without persisting the failed turn and retries the same prompt", async () => {
    let handler: ((event: AiStreamEvent) => void) | null = null;
    vi.mocked(startPrompt).mockImplementation(async (_request, onEvent) => {
      handler = onEvent;
      return { runId: "run_1", stop: vi.fn() };
    });
    render(<AiPanel contexts={contexts} staging={staging} />);
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "書いて" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await vi.waitFor(() => expect(handler).not.toBeNull());
    emit([{ type: "started", payload: { runId: "run_1" } }], handler!);
    expect(await screen.findByRole("button", { name: "取り消し" })).toBeVisible();
    emit([{ type: "cancelled", payload: { runId: "run_1" } }], handler!);
    expect(await screen.findByText("取り消しました。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    await vi.waitFor(() => expect(vi.mocked(startPrompt)).toHaveBeenCalledTimes(2));
    const retry = vi.mocked(startPrompt).mock.calls[1][0];
    expect(retry.prompt).toBe("書いて");
    expect(retry.history).toEqual([]);
  });

  it("shows stream errors as alerts with retry", async () => {
    vi.mocked(startPrompt).mockImplementation(async (_request, onEvent) => {
      onEvent({ type: "error", payload: { runId: "run_2", error: { code: "auth_failed", detail: "bad key" } } });
      return { runId: "run_2", stop: vi.fn() };
    });
    render(<AiPanel contexts={[]} staging={staging} />);
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "質問" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("認証に失敗しました");
    expect(screen.getByRole("button", { name: "再試行" })).toBeEnabled();
  });

  it("preserves stale base revisions on the proposal for review", async () => {
    const seen: Array<{ text: string }> = [];
    vi.mocked(startPrompt).mockImplementation(async (_request, onEvent) => {
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
        contexts={contexts}
        staging={staging}
        onProposal={(proposal) => seen.push({ text: proposal.text })}
      />,
    );
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "書いて" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(await screen.findByText("古い基準の提案")).toBeVisible();
    expect(screen.getByText(/doc_01 rev 6/)).toBeVisible();
    expect(seen).toHaveLength(1);
  });

  it("blocks sending while staging is unresolved and reports it", async () => {
    render(<AiPanel contexts={contexts} staging={null} />);
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "質問" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/作業コピー/);
    expect(startPrompt).not.toHaveBeenCalled();
  });

  it("saves credentials through the OS store without displaying values", async () => {
    const { default: Settings } = await import("./ai-provider-settings");
    expect(Settings).toBeDefined();
    vi.mocked(getCredentialState).mockResolvedValue({ provider: "openai_compatible", hasSecret: true });
    expect(setCredential).toBeDefined();
    expect(testConnection).toBeDefined();
  });

  it("persists profile changes without secrets and reports proposals once", async () => {
    const seen: Array<[object, object]> = [];
    vi.mocked(startPrompt).mockImplementation(async (_request, onEvent) => {
      onEvent({ type: "started", payload: { runId: "run_9" } });
      onEvent({
        type: "done",
        payload: {
          runId: "run_9",
          proposal: { text: "提案です", baseContexts: [{ documentId: "doc_01", revision: 7 }] },
          sent: [{ documentId: "doc_01", revision: 7, ranges: [{ start: 1, end: 3 }], chars: 5 }],
        },
      });
      return { runId: "run_9", stop: vi.fn() };
    });
    render(<AiPanel contexts={contexts} staging={staging} onProposal={(proposal, sent) => seen.push([proposal, sent])} />);
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "書いて" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(await screen.findByText("提案です")).toBeVisible();
    expect(seen).toHaveLength(1);
    expect(window.localStorage.getItem("marxen.ai-profile.v1") ?? "").not.toContain("s3cret");
  });
});
