import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import InlineChat from "./ai-inline-chat";
import { startPrompt } from "../lib/ai";
import type { AiStreamEvent, PromptContext } from "../shared/ai-contracts";

vi.mock("../lib/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ai")>();
  return { ...actual, startPrompt: vi.fn(), cancelPromptSafe: vi.fn() };
});

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
});

const context: PromptContext = {
  documentId: "doc_a",
  revision: 3,
  ranges: [{ start: 4, end: 9 }],
  text: "# A\n本文\n",
};

describe("inline chat", () => {
  it("targets the separate inline context and offers an explicit review action", async () => {
    let handler: ((event: AiStreamEvent) => void) | null = null;
    vi.mocked(startPrompt).mockImplementation(async (request, onEvent) => {
      expect(request.contexts).toHaveLength(1);
      expect(request.contexts[0]).toMatchObject({ documentId: "doc_a", revision: 3 });
      expect(request.mode).toBe("rewrite");
      handler = onEvent;
      return { runId: "run_inline", stop: vi.fn() };
    });
    const onProposal = vi.fn();
    const onReview = vi.fn();
    render(
      <InlineChat
        documentId="doc_a"
        target={{ start: 4, end: 9, kind: "selection", excerpt: "本文" }}
        context={context}
        staging={{ copyId: "copy_inline" }}
        ensureStaging={vi.fn()}
        provider={{ kind: "acp", acp: { preset: "codex", argv: null }, openai: null, anthropic: null }}
        onProposal={onProposal}
        onReview={onReview}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByTestId("inline-chat")).toHaveTextContent(/選択/);
    expect(screen.getByText(/doc_a rev 3/)).toBeVisible();
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
    vi.mocked(startPrompt).mockImplementation(async (_request, onEvent) => {
      handler = onEvent;
      return { runId: "run_inline2", stop: vi.fn() };
    });
    render(
      <InlineChat
        documentId="doc_a"
        target={{ start: 0, end: 3, kind: "paragraph", excerpt: "# A" }}
        context={context}
        staging={{ copyId: "copy_inline" }}
        ensureStaging={vi.fn()}
        provider={{ kind: "acp", acp: { preset: "codex", argv: null }, openai: null, anthropic: null }}
        onProposal={() => undefined}
        onReview={() => undefined}
        onClose={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText("インライン指示"), { target: { value: "直して" } });
    fireEvent.click(screen.getByRole("button", { name: "インライン送信" }));
    await vi.waitFor(() => expect(handler).not.toBeNull());
    handler!({ type: "started", payload: { runId: "run_inline2" } });
    expect(await screen.findByRole("button", { name: "インライン取消" })).toBeVisible();
    handler!({ type: "cancelled", payload: { runId: "run_inline2" } });
    expect(await screen.findByText("取り消しました。")).toBeVisible();
  });
});
