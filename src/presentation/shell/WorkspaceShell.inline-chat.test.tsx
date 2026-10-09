import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import App from "../../App";
import { readRuntimeStatus } from "../../infrastructure/tauri/runtime-client";
import { invoke } from "@tauri-apps/api/core";
import { startPrompt } from "../../infrastructure/tauri/ai-client";
import type { AiStreamEvent } from "../../contracts/ai-contracts";

vi.mock("../../infrastructure/tauri/runtime-client", () => ({ readRuntimeStatus: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../../infrastructure/tauri/ai-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infrastructure/tauri/ai-client")>();
  return { ...actual, startPrompt: vi.fn(), cancelPromptSafe: vi.fn() };
});

const mockedInvoke = vi.mocked(invoke);
const mockedStartPrompt = vi.mocked(startPrompt);

const backend = {
  docs: new Map<string, { id: string; path: string; text: string; revision: number; dirty: boolean }>(),
  copies: new Map<string, { documentId: string; revision: number }>(),
  copySeq: 0,
};

function resetBackend() {
  backend.docs = new Map([
    ["メモ/a.md", { id: "doc_a", path: "メモ/a.md", text: "# A\n", revision: 0, dirty: false }],
  ]);
  backend.copies = new Map();
  backend.copySeq = 0;
}

function installBackend() {
  mockedInvoke.mockImplementation((command: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (command) {
      case "open_workspace":
        return Promise.resolve({ root: a.path });
      case "list_workspace":
        return Promise.resolve(
          a.path === ""
            ? [{ path: "メモ", name: "メモ", directory: true, markdown: false }]
            : [{ path: "メモ/a.md", name: "a.md", directory: false, markdown: true }],
        );
      case "list_documents":
        return Promise.resolve([]);
      case "open_markdown": {
        const doc = backend.docs.get(a.path as string)!;
        return Promise.resolve({ path: doc.path, snapshot: { documentId: doc.id, revision: doc.revision, text: doc.text, dirty: doc.dirty } });
      }
      case "fetch_snapshot": {
        const doc = [...backend.docs.values()].find((entry) => entry.id === a.documentId)!;
        return Promise.resolve({ documentId: doc.id, revision: doc.revision, text: doc.text, dirty: doc.dirty });
      }
      case "fetch_mode":
        return Promise.resolve({ documentId: a.documentId, revision: 0, mode: "normal" });
      case "fetch_cursor":
        return Promise.resolve({ documentId: a.documentId, revision: 0, anchor: 0, head: 0 });
      case "report_cursor":
        return Promise.resolve({ documentId: a.documentId, revision: a.revision, anchor: a.anchor, head: a.head });
      case "poll_workspace_events":
        return Promise.resolve([]);
      case "list_recovery":
        return Promise.resolve([]);
      case "fetch_grid":
        return Promise.resolve({ documentId: a.documentId, revision: 0, updates: [] });
      case "fetch_config":
        return Promise.resolve({ path: null, errors: [] });
      case "isolation_create": {
        const contexts = a.contexts as Array<{ documentId: string; revision: number }>;
        backend.copySeq += 1;
        const copyId = `copy_${backend.copySeq}`;
        backend.copies.set(copyId, { documentId: contexts[0].documentId, revision: contexts[0].revision });
        return Promise.resolve({ copyId, documents: [] });
      }
      case "isolation_stage_proposal":
        return Promise.resolve({ copyId: a.copyId, updated: ["doc_a"], chars: 6 });
      case "isolation_diff": {
        const copy = backend.copies.get(a.copyId as string);
        if (!copy) throw { code: "not_found" };
        return Promise.resolve([
          {
            documentId: copy.documentId,
            path: "メモ/a.md",
            range: { start: 0, end: 0 },
            baseRevision: copy.revision,
            liveRevision: copy.revision,
            drifted: false,
            changed: true,
            unified: "-//A\n+//A staged\n",
            stagingChars: 10,
            liveChars: 4,
          },
        ]);
      }
      case "isolation_reject":
      case "isolation_cancel":
        backend.copies.delete(a.copyId as string);
        return Promise.resolve();
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  resetBackend();
  installBackend();
  vi.mocked(readRuntimeStatus).mockResolvedValue({ contractVersion: 1, connection: "connected", detail: "live" });
});

let handler: ((event: AiStreamEvent) => void) | null = null;

function mockStream() {
  mockedStartPrompt.mockImplementation(async (_request, onEvent) => {
    handler = onEvent;
    return { runId: "run_inline", stop: vi.fn() };
  });
}

async function openDocAndAi() {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "パスを入力する" }));
  fireEvent.change(screen.getByLabelText("開くフォルダーの絶対パス"), { target: { value: "/ws" } });
  fireEvent.click(screen.getByRole("button", { name: "開く" }));
  await screen.findByRole("button", { name: "メモ/a.md" });
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await screen.findByText("# A");
  fireEvent.click(screen.getByRole("button", { name: "AI 支援" }));
  await screen.findByTestId("ai-sidebar");
}

it("opens inline chat with Ctrl+Shift+I on the paragraph target and reviews the proposal", async () => {
  mockStream();
  await openDocAndAi();
  fireEvent.keyDown(window, { key: "i", ctrlKey: true, shiftKey: true });
  const inline = await screen.findByTestId("inline-chat");
  expect(inline).toHaveTextContent(/段落/);
  expect(inline).toHaveTextContent("a.md");
  expect(inline).not.toHaveTextContent(/doc_a/);
  const inlineBox = within(inline);
  fireEvent.change(inlineBox.getByLabelText("インライン指示"), { target: { value: "短く" } });
  fireEvent.click(inlineBox.getByRole("button", { name: "インライン送信" }));
  await waitFor(() => expect(handler).not.toBeNull());
  handler!({ type: "started", payload: { runId: "run_inline" } });
  handler!({
    type: "done",
    payload: {
      runId: "run_inline",
      proposal: { text: "短い案", baseContexts: [{ documentId: "doc_a", revision: 0 }] },
      sent: [{ documentId: "doc_a", revision: 0, ranges: [{ start: 0, end: 3 }], chars: 4 }],
    },
  });
  expect(await within(inline).findByText("短い案")).toBeVisible();
  const request = mockedStartPrompt.mock.calls[0][0];
  expect(request.mode).toBe("rewrite");
  expect(request.contexts[0]).toMatchObject({ documentId: "doc_a", revision: 0 });
  // Inline target (paragraph [0,3)) stays separate from the agent selection scope.
  expect(request.contexts[0].ranges).toEqual([{ start: 0, end: 3 }]);
  expect(request.contexts[0].text).toBe("# A");
  expect(await screen.findByTestId("ai-proposal")).toHaveTextContent("短い案");
  fireEvent.click(inlineBox.getByRole("button", { name: "差分を確認" }));
  await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("isolation_diff", expect.objectContaining({ copyId: expect.any(String) })));
  expect(await screen.findByText(/変更あり/)).toBeVisible();
});

it("ignores plain Ctrl+I so native Vim input keeps the key", async () => {
  mockStream();
  await openDocAndAi();
  fireEvent.keyDown(window, { key: "i", ctrlKey: true });
  expect(screen.queryByTestId("inline-chat")).not.toBeInTheDocument();
});

it("captures the inline shortcut before the editor sends it to Neovim", async () => {
  mockStream();
  await openDocAndAi();
  const editor = screen.getByTestId("editor-primary").querySelector(".cm-content")!;
  mockedInvoke.mockClear();
  fireEvent.keyDown(editor, { key: "i", ctrlKey: true, shiftKey: true });
  expect(await screen.findByTestId("inline-chat")).toBeVisible();
  expect(mockedInvoke.mock.calls.some(([name]) => name === "input_with_copy" || name === "nvim_input")).toBe(false);
});

it("preserves the Agent transcript across hide and show", async () => {
  let agentHandler: ((event: AiStreamEvent) => void) | null = null;
  mockedStartPrompt.mockImplementation(async (_request, onEvent) => {
    agentHandler = onEvent;
    return { runId: "run_hide", stop: vi.fn() };
  });
  await openDocAndAi();
  const sidebar = screen.getByTestId("ai-sidebar");
  fireEvent.change(within(sidebar).getByLabelText("プロンプト"), { target: { value: "覚えて" } });
  fireEvent.click(within(sidebar).getByRole("button", { name: "送信" }));
  await waitFor(() => expect(agentHandler).not.toBeNull());
  expect(mockedStartPrompt.mock.calls[0][0].contexts[0]).toMatchObject({
    ranges: [{ start: 0, end: 4 }], text: "# A\n",
  });
  agentHandler!({ type: "started", payload: { runId: "run_hide" } });
  agentHandler!({
    type: "done",
    payload: {
      runId: "run_hide",
      proposal: { text: "保持される回答", baseContexts: [{ documentId: "doc_a", revision: 0 }] },
      sent: [{ documentId: "doc_a", revision: 0, ranges: [{ start: 0, end: 0 }], chars: 4 }],
    },
  });
  expect(await within(within(sidebar).getByLabelText("会話")).findByText("保持される回答")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "AI 支援" }));
  expect(screen.getByTestId("ai-sidebar").className).toContain("hidden");
  fireEvent.click(screen.getByRole("button", { name: "AI 支援" }));
  expect(screen.getAllByText("保持される回答").length).toBeGreaterThanOrEqual(1);
});


