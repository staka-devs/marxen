import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import InlineChat from "./ai-inline-chat";
import type { AiStreamEvent, PromptContext } from "../contracts/ai-contracts";
import type { AiGateway } from "../application/ports";

const mockStartPrompt = vi.fn<AiGateway["startPrompt"]>();

beforeEach(() => {
  vi.resetAllMocks();
  mockStartPrompt.mockReset();
  window.localStorage.clear();
});

const context: PromptContext = {
  documentId: "doc_a",
  revision: 3,
  ranges: [{ start: 4, end: 9 }],
  text: "# A\n本文\n",
};

const provider = { kind: "acp", acp: { preset: "codex", argv: null }, openai: null, anthropic: null } as const;

/** Render inline chat with defaults and injected start mock for tests. */ function renderInline(extra?: Partial<Parameters<typeof InlineChat>[0]>) {
  return render(
    <InlineChat
      documentId="doc_a"
      documentLabel="a.md"
      target={{ start: 4, end: 9, kind: "selection", excerpt: "本文" }}
      context={context}
      staging={{ copyId: "copy_inline" }}
      ensureStaging={vi.fn(async () => ({ copyId: "copy_inline" }))}
      provider={{ ...provider }}
      onProposal={() => undefined}
      onReview={() => undefined}
      onClose={() => undefined}
      startPrompt={mockStartPrompt}
      {...extra}
    />,
  );
}

describe("inline chat", () => {
  it("discards a response completed after the user requested cancellation", async () => {
    let handler!: (event: AiStreamEvent) => void;
    const onProposal = vi.fn();
    mockStartPrompt.mockImplementation(async (_request, onEvent) => {
      handler = onEvent;
      return {
        runId: "inline-cancel",
        /** Owned stop handle for the cancelled run. */
        stop: vi.fn(async () => undefined),
      };
    });
    renderInline({ onProposal });
    fireEvent.change(screen.getByLabelText("インライン指示"), { target: { value: "止める" } });
    fireEvent.click(screen.getByRole("button", { name: "インライン送信" }));
    await vi.waitFor(() => expect(mockStartPrompt).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "インライン取消" }));
    handler({ type: "done", payload: { runId: "inline-cancel", proposal: { text: "取消後の提案", baseContexts: [] }, sent: [] } });
    expect(await screen.findByText("取り消しました。")).toBeVisible();
    expect(onProposal).not.toHaveBeenCalled();
    expect(screen.queryByText("取消後の提案")).not.toBeInTheDocument();
  });

  it("holds its busy ownership until a pending start is cancelled after unmount", async () => {
    /** Deferred session resolver coupling run ID with its stop handle. */
    let resolve!: (value: {
      runId: string;
      /** Owned stop handle for the pending session. */
      stop: () => Promise<void>;
    }) => void;
    /** Pending session coupling run ID with its stop handle. */
    const pending = new Promise<{
      runId: string;
      /** Owned stop handle for the pending session. */
      stop: () => Promise<void>;
    }>((done) => { resolve = done; });
    mockStartPrompt.mockReturnValue(pending);
    /** Owned stop handle recording cancellation. */
    const stop = vi.fn(async () => undefined);
    const onBusyChange = vi.fn();
    const { unmount } = renderInline({ onBusyChange });
    fireEvent.change(screen.getByLabelText("インライン指示"), { target: { value: "保留中" } });
    fireEvent.click(screen.getByRole("button", { name: "インライン送信" }));
    await vi.waitFor(() => expect(mockStartPrompt).toHaveBeenCalled());
    unmount();
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    resolve({ runId: "late", stop });
    await vi.waitFor(() => expect(stop).toHaveBeenCalled());
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });
  it("targets the separate inline context and offers an explicit review action", async () => {
    let handler: ((event: AiStreamEvent) => void) | null = null;
    mockStartPrompt.mockImplementation(async (request, onEvent) => {
      expect(request.contexts).toHaveLength(1);
      expect(request.contexts[0]).toMatchObject({ documentId: "doc_a", revision: 3 });
      expect(request.mode).toBe("rewrite");
      handler = onEvent;
      return { runId: "run_inline", stop: vi.fn() };
    });
    const onProposal = vi.fn();
    const onReview = vi.fn();
    renderInline({ onProposal, onReview });
    expect(screen.getByTestId("inline-chat")).toHaveTextContent(/選択/);
    expect(screen.getByText("a.md")).toBeVisible();
    expect(screen.getByText("本文")).toBeVisible();
    expect(screen.queryByText(/doc_a/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("インライン指示"), { target: { value: "短く" } });
    fireEvent.click(screen.getByRole("button", { name: "インライン送信" }));
    await vi.waitFor(() => expect(handler).not.toBeNull());
    handler!({ type: "started", payload: { runId: "run_inline" } });
    handler!({
      type: "done",
      payload: {
        runId: "run_inline",
        proposal: { text: "短い案", baseContexts: [{ documentId: "doc_a", revision: 3 }] },
        sent: [{ documentId: "doc_a", revision: 3, ranges: [{ start: 4, end: 9 }], chars: 6 }],
      },
    });
    expect(await screen.findByText("短い案")).toBeVisible();
    expect(onProposal).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Markdownを変更しました/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "差分を確認" }));
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it("cancels the inline run without touching the document", async () => {
    let handler: ((event: AiStreamEvent) => void) | null = null;
    mockStartPrompt.mockImplementation(async (_request, onEvent) => {
      handler = onEvent;
      return {
        runId: "run_inline2",
        /** Owned stop handle for the asserted run. */
        stop: vi.fn(),
      };
    });
    renderInline({ target: { start: 0, end: 3, kind: "paragraph", excerpt: "# A" } });
    fireEvent.change(screen.getByLabelText("インライン指示"), { target: { value: "直して" } });
    fireEvent.click(screen.getByRole("button", { name: "インライン送信" }));
    await vi.waitFor(() => expect(handler).not.toBeNull());
    handler!({ type: "started", payload: { runId: "run_inline2" } });
    expect(await screen.findByRole("button", { name: "インライン取消" })).toBeVisible();
    handler!({ type: "cancelled", payload: { runId: "run_inline2" } });
    expect(await screen.findByText("取り消しました。")).toBeVisible();
  });

  it("closes with Escape after requesting cancellation", async () => {
    let handler: ((event: AiStreamEvent) => void) | null = null;
    /** Owned stop handle recording cancellation. */
    const stop = vi.fn(async () => undefined);
    mockStartPrompt.mockImplementation(async (_request, onEvent) => {
      handler = onEvent;
      return { runId: "run_inline3", stop };
    });
    const onClose = vi.fn();
    renderInline({ onClose });
    fireEvent.change(screen.getByLabelText("インライン指示"), { target: { value: "直して" } });
    fireEvent.click(screen.getByRole("button", { name: "インライン送信" }));
    await vi.waitFor(() => expect(handler).not.toBeNull());
    handler!({ type: "started", payload: { runId: "run_inline3" } });
    await vi.waitFor(() => expect(stop).not.toHaveBeenCalled());
    fireEvent.keyDown(screen.getByTestId("inline-chat"), { key: "Escape" });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("stays fenced while the Agent chat owns a run", () => {
    renderInline({ disabled: true });
    fireEvent.change(screen.getByLabelText("インライン指示"), { target: { value: "直して" } });
    expect(screen.getByRole("button", { name: "インライン送信" })).toBeDisabled();
    expect(screen.getByText("他の応答を生成しています。")).toBeVisible();
    expect(mockStartPrompt).not.toHaveBeenCalled();
  });
});




