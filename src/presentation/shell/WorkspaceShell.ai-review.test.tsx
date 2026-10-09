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

interface BackendDoc {
  id: string;
  path: string;
  text: string;
  revision: number;
  dirty: boolean;
}

const backend = {
  docs: new Map<string, BackendDoc>(),
  copies: new Map<string, { documentId: string; revision: number }>(),
  copySeq: 0,
  approveStaleOnce: false,
};

function resetBackend() {
  backend.docs = new Map([
    ["メモ/a.md", { id: "doc_a", path: "メモ/a.md", text: "# A\n", revision: 0, dirty: false }],
  ]);
  backend.copies = new Map();
  backend.copySeq = 0;
  backend.approveStaleOnce = false;
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
        return Promise.resolve({ copyId, documents: [{ documentId: contexts[0].documentId, revision: contexts[0].revision, path: "メモ/a.md", ranges: [{ start: 0, end: 0 }], fullDocument: false }] });
      }
      case "isolation_stage_proposal": {
        const copy = backend.copies.get(a.copyId as string);
        if (!copy) throw { code: "not_found" };
        const proposal = a.proposal as { text: string; baseContexts: Array<{ documentId: string; revision: number }> };
        const mode = a.mode as string;
        if (mode === "ask") throw { code: "io", detail: "質問モードは表示のみです。" };
        if (!proposal || typeof proposal.text !== "string") throw { code: "io", detail: "提案が不正です。" };
        return Promise.resolve({ copyId: a.copyId, updated: [copy.documentId], chars: proposal.text.length });
      }
      case "isolation_diff": {
        const copy = backend.copies.get(a.copyId as string);
        if (!copy) throw { code: "not_found" };
        const doc = [...backend.docs.values()].find((entry) => entry.id === copy.documentId)!;
        return Promise.resolve([
          {
            documentId: doc.id,
            path: doc.path,
            range: { start: 0, end: 0 },
            baseRevision: copy.revision,
            liveRevision: doc.revision,
            drifted: doc.revision !== copy.revision,
            changed: true,
            unified: "-//A\n+//A staged\n",
            stagingChars: 10,
            liveChars: 4,
          },
        ]);
      }
      case "isolation_approve": {
        const copy = backend.copies.get(a.copyId as string);
        if (!copy) throw { code: "not_found" };
        if (backend.approveStaleOnce) {
          backend.approveStaleOnce = false;
          throw { code: "contract", error: { code: "stale_revision", expected: 5, received: 4 } };
        }
        const doc = [...backend.docs.values()].find((entry) => entry.id === copy.documentId)!;
        doc.text += "[適用]";
        doc.revision += 1;
        doc.dirty = true;
        backend.copies.delete(a.copyId as string);
        return Promise.resolve({
          copyId: a.copyId,
          outcomes: [{ documentId: doc.id, applied: true, revision: doc.revision, error: null, rolledBack: false, rollbackError: null }],
        });
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
    return { runId: "run_1", stop: vi.fn() };
  });
}

function emitDone() {
  handler!({ type: "started", payload: { runId: "run_1" } });
  handler!({
    type: "done",
    payload: {
      runId: "run_1",
      proposal: { text: "提案文", baseContexts: [{ documentId: "doc_a", revision: 0 }] },
      sent: [{ documentId: "doc_a", revision: 0, ranges: [{ start: 0, end: 0 }], chars: 4 }],
    },
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

async function registerAndSend() {
  // Preparation is automatic on send: no manual registration step.
  const sidebar = screen.getByTestId("ai-sidebar");
  fireEvent.change(within(sidebar).getByLabelText("モード"), { target: { value: "rewrite" } });
  fireEvent.change(within(sidebar).getByLabelText("プロンプト"), { target: { value: "書いて" } });
  fireEvent.click(within(sidebar).getByRole("button", { name: "送信" }));
  await waitFor(() => expect(handler).not.toBeNull());
  emitDone();
}

it("registers exact scope, stages the proposal, diffs, and applies with per-doc outcomes", async () => {
  mockStream();
  await openDocAndAi();
  expect(within(screen.getByTestId("ai-sidebar")).getByText("a.md")).toBeVisible();
  await registerAndSend();
  expect(mockedInvoke).toHaveBeenCalledWith(
    "isolation_create",
    expect.objectContaining({ contexts: [expect.objectContaining({ documentId: "doc_a", revision: 0 })] }),
  );
  const request = mockedStartPrompt.mock.calls[0][0];
  expect(request.staging).toEqual({ copyId: "copy_1" });
  expect(request.mode).toBe("rewrite");
  expect(await screen.findByTestId("ai-proposal")).toHaveTextContent("提案文");
  await waitFor(() =>
    expect(mockedInvoke).toHaveBeenCalledWith(
      "isolation_stage_proposal",
      expect.objectContaining({ copyId: "copy_1", mode: "rewrite" }),
    ),
  );
  await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("isolation_diff", { copyId: "copy_1" }));
  expect(await screen.findByText(/変更あり/)).toBeVisible();
  expect(await screen.findByText(/取り込みました/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "承認して適用" }));
  await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("isolation_approve", { copyId: "copy_1" }));
  await waitFor(() => expect(screen.getByTestId("revision")).toHaveTextContent("リビジョン 1"));
  expect(await screen.findByLabelText("承認結果")).toHaveTextContent(/a\.md.*適用/);
  expect(screen.queryByTestId("ai-proposal")).not.toBeInTheDocument();
  expect(backend.docs.get("メモ/a.md")!.text).toContain("[適用]");
});

it("displays ask proposals without staging", async () => {
  mockStream();
  await openDocAndAi();
  const sidebar = screen.getByTestId("ai-sidebar");
  // Default mode stays ask: proposal displays, stage is refused.
  fireEvent.change(within(sidebar).getByLabelText("プロンプト"), { target: { value: "教えて" } });
  fireEvent.click(within(sidebar).getByRole("button", { name: "送信" }));
  await waitFor(() => expect(handler).not.toBeNull());
  emitDone();
  await waitFor(() => expect(within(sidebar).getByLabelText("AI の回答")).toHaveTextContent("提案文"));
  expect(screen.queryByTestId("ai-proposal")).not.toBeInTheDocument();
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "isolation_stage_proposal")).toHaveLength(0);
  expect(await screen.findByText(/表示のみ/)).toBeVisible();
});

it("treats an unchanged scope as success alongside an applied document", async () => {
  mockStream();
  await openDocAndAi();
  await registerAndSend();
  await screen.findByTestId("ai-proposal");
  // Simulate the applied buffer moving; the unchanged scope stays put.
  const doc = backend.docs.get("メモ/a.md")!;
  doc.text += "[適用]";
  doc.revision += 1;
  doc.dirty = true;
  mockedInvoke.mockResolvedValueOnce({
    copyId: "copy_1",
    outcomes: [
      { documentId: "doc_a", applied: true, revision: 1, error: null, rolledBack: false, rollbackError: null },
      { documentId: "doc_b", applied: false, revision: 0, error: null, rolledBack: false, rollbackError: null },
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: "承認して適用" }));
  await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("isolation_approve", { copyId: "copy_1" }));
  const results = await screen.findByLabelText("承認結果");
  expect(results).toHaveTextContent(/a\.md.*適用/);
  expect(results).toHaveTextContent(/文書.*変更なし/);
  // Unchanged is success: no failure text, no false all-or-nothing label.
  expect(screen.queryByText(/未適用/)).not.toBeInTheDocument();
  expect(screen.queryByText(/all-or-nothing/i)).not.toBeInTheDocument();
  expect(await screen.findByText(/1 文書に適用し、1 文書は変更なし/)).toBeVisible();
  await waitFor(() => expect(screen.getByTestId("revision")).toHaveTextContent("リビジョン 1"));
});

it("reports a rollback failure per document without all-or-nothing claims", async () => {
  mockStream();
  await openDocAndAi();
  await registerAndSend();
  await screen.findByTestId("ai-proposal");
  mockedInvoke.mockResolvedValueOnce({
    copyId: "copy_1",
    outcomes: [
      { documentId: "doc_a", applied: false, revision: 0, error: "neovim error", rolledBack: true, rollbackError: "rollback failed" },
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: "承認して適用" }));
  await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("isolation_approve", { copyId: "copy_1" }));
  const results = await screen.findByLabelText("承認結果");
  expect(results).toHaveTextContent(/a\.md.*未適用/);
  expect(results).toHaveTextContent(/ロールバック済み/);
  expect(results).toHaveTextContent(/ロールバック失敗/);
  expect(await screen.findByText(/1 文書が未適用/)).toBeVisible();
  expect(screen.queryByText(/all-or-nothing/i)).not.toBeInTheDocument();
  expect(backend.docs.get("メモ/a.md")!.text).toBe("# A\n");
  expect(screen.getByTestId("revision")).toHaveTextContent("リビジョン 0");
});

it("rejects without touching source or disk state", async () => {
  mockStream();
  await openDocAndAi();
  await registerAndSend();
  await screen.findByTestId("ai-proposal");
  fireEvent.click(screen.getByRole("button", { name: /^却下$/ }));
  await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("isolation_reject", { copyId: "copy_1" }));
  expect(backend.docs.get("メモ/a.md")!.text).toBe("# A\n");
  expect(screen.queryByTestId("ai-proposal")).not.toBeInTheDocument();
});

it("cancels cleanup after the run settles", async () => {
  mockStream();
  await openDocAndAi();
  await registerAndSend();
  await screen.findByTestId("ai-proposal");
  fireEvent.click(screen.getByRole("button", { name: /^取消$/ }));
  await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("isolation_cancel", { copyId: "copy_1" }));
  expect(backend.docs.get("メモ/a.md")!.text).toBe("# A\n");
});

it("refuses stale approval and keeps text for resync", async () => {
  mockStream();
  await openDocAndAi();
  await registerAndSend();
  await screen.findByTestId("ai-proposal");
  backend.approveStaleOnce = true;
  fireEvent.click(screen.getByRole("button", { name: "承認して適用" }));
  await screen.findByText(/再登録/);
  expect(backend.docs.get("メモ/a.md")!.text).toBe("# A\n");
  expect(screen.getByTestId("revision")).toHaveTextContent("リビジョン 0");
});


