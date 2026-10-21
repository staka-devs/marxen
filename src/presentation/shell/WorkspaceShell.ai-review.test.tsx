import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import App from "../../App";
import { readRuntimeStatus } from "../../infrastructure/tauri/runtime-client";
import { invoke } from "@tauri-apps/api/core";
import { startPrompt } from "../../infrastructure/tauri/ai-client";
import type { AiStreamEvent } from "../../contracts/ai-contracts";

vi.mock("../../infrastructure/tauri/runtime-client", () => {
  /** Mocked status reader controllable per test. */
  const readRuntimeStatus = vi.fn();
  return {
    readRuntimeStatus,
    /** Gateway delegating to the mocked status reader. */
    runtimeGateway: {
      /** Status reader delegating to the mock. */
      readStatus: readRuntimeStatus,
    },
  };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  /** Desktop transport flag for shell tests. */
  isTauri: () => true,
}));
vi.mock("@tauri-apps/api/event", () => ({
  /** Event subscription resolving to a no-op unlisten. */
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../../infrastructure/tauri/ai-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infrastructure/tauri/ai-client")>();
  /** Mocked streaming starter for deterministic run assertions. */
  const startPrompt = vi.fn();
  /** Mocked best-effort cancel settling immediately. */
  const cancelPromptSafe = vi.fn();
  return {
    ...actual,
    startPrompt,
    cancelPromptSafe,
    /** Injected AI gateway using the mocked streaming starter. */
    aiGateway: { ...actual.aiGateway, startPrompt, cancelPromptSafe },
  };
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
  editAfterSave: null as string | null,
  /** Replaces the approve reply (and skips the fake text change) when set. */
  approveOverride: null as unknown,
};

/** Reset the fake native backend to one sample document. */
function resetBackend() {
  backend.docs = new Map([
    ["メモ/a.md", { id: "doc_a", path: "メモ/a.md", text: "# A\n", revision: 0, dirty: false }],
  ]);
  backend.copies = new Map();
  backend.copySeq = 0;
  backend.approveStaleOnce = false;
  backend.editAfterSave = null;
  backend.approveOverride = null;
}

/** Install the fake Tauri backend answering workspace and isolation commands. */
function installBackend() {
  mockedInvoke.mockImplementation((command: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (command) {
      case "open_workspace":
        return Promise.resolve({ root: a.path, scope: { rootId: "fixture-root", generation: "1" } });
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
        if (mode === "workspace") throw { code: "invalid_scope", detail: "workspace 提案に patch ブロックがありません" };
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
        if (backend.approveOverride) {
          backend.copies.delete(a.copyId as string);
          return Promise.resolve(backend.approveOverride);
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
      case "isolation_new_files":
        return Promise.resolve([]);
      case "isolation_import_new":
        return Promise.resolve([]);
      case "save_document": {
        const wantId = (a.documentId as string) ?? (a.request as { documentId: string } | undefined)?.documentId;
        const doc = [...backend.docs.values()].find((entry) => entry.id === wantId);
        if (!doc) throw { code: "not_found" };
        doc.dirty = false;
        const savedRevision = doc.revision;
        if (backend.editAfterSave !== null) {
          doc.text += backend.editAfterSave;
          doc.revision += 1;
          doc.dirty = true;
        }
        return Promise.resolve({ documentId: doc.id, revision: savedRevision, dirty: false });
      }
      case "apply_gui_edits": {
        const doc = [...backend.docs.values()].find((entry) => entry.id === a.documentId)!;
        for (const edit of a.edits as Array<{ range: { start: number; end: number }; text: string }>) {
          doc.text = doc.text.slice(0, edit.range.start) + edit.text + doc.text.slice(edit.range.end);
        }
        doc.revision += 1;
        doc.dirty = true;
        return Promise.resolve({ documentId: doc.id, revision: doc.revision, text: doc.text, dirty: doc.dirty });
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

/** Capture the stream handler returning a fixed run for assertions. */ function mockStream() {
  mockedStartPrompt.mockImplementation(async (_request, onEvent) => {
    handler = onEvent;
    return { runId: "run_1", stop: vi.fn() };
  });
}

/** Emit a started and done pair carrying the fixed proposal. */ function emitDone() {
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

/** Open the sample document and reveal the AI sidebar. */ async function openDocAndAi() {
  render(<App />);
  fireEvent.click(screen.getByRole("menuitem", { name: "ファイル" }));
  await waitFor(() => expect(screen.getByRole("menuitem", { name: "パスを入力する" })).toBeEnabled());
  fireEvent.click(screen.getByRole("menuitem", { name: "パスを入力する" }));
  fireEvent.change(screen.getByLabelText("開くフォルダーの絶対パス"), { target: { value: "/ws" } });
  fireEvent.click(screen.getByRole("button", { name: "開く" }));
  await screen.findByRole("button", { name: "メモ/a.md" });
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await vi.waitFor(() => expect(screen.getByTestId("editor-primary")).toHaveTextContent("# A"));
  fireEvent.click(screen.getByRole("button", { name: "チャットを切り替える" }));
  await screen.findByTestId("ai-sidebar");
}

/** Send a rewrite prompt through automatic staging registration. */ async function registerAndSend() {
  // Preparation is automatic on send: no manual registration step.
  const sidebar = screen.getByTestId("ai-sidebar");
  fireEvent.click(within(sidebar).getByRole("combobox", { name: "モード" }));
  fireEvent.click(screen.getByRole("option", { name: /推敲/ }));
  fireEvent.change(within(sidebar).getByLabelText("プロンプト"), { target: { value: "書いて" } });
  fireEvent.click(within(sidebar).getByRole("button", { name: "送信" }));
  await waitFor(() => expect(handler).not.toBeNull());
  emitDone();
}

it("writes the AI change into the document, saves it, and shows it for keep or undo", async () => {
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
  await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("isolation_stage_proposal", expect.objectContaining({ copyId: "copy_1", mode: "rewrite" })));
  // No approval click: the change lands in the file like other agents.
  await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("isolation_approve", { copyId: "copy_1" }));
  await waitFor(() => expect(screen.getByTestId("revision")).toHaveTextContent("リビジョン 1"));
  await waitFor(() => expect(screen.getByTestId("dirty")).toHaveTextContent("保存済み"));
  expect(backend.docs.get("メモ/a.md")!.text).toContain("[適用]");
  const bar = await screen.findByRole("region", { name: "AI の変更" });
  expect(bar).toHaveTextContent("a.md");
  expect(screen.queryByText("提案文")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "適用して保存" })).not.toBeInTheDocument();
});

it("keeps the change and clears the highlight", async () => {
  mockStream();
  await openDocAndAi();
  await registerAndSend();
  const bar = await screen.findByRole("region", { name: "AI の変更" });
  fireEvent.click(within(bar).getByRole("button", { name: "保持" }));
  expect(screen.queryByRole("region", { name: "AI の変更" })).not.toBeInTheDocument();
  expect(backend.docs.get("メモ/a.md")!.text).toBe("# A\n[適用]");
});

it("undoes the change by restoring and saving the original text", async () => {
  mockStream();
  await openDocAndAi();
  await registerAndSend();
  const bar = await screen.findByRole("region", { name: "AI の変更" });
  fireEvent.click(within(bar).getByRole("button", { name: "元に戻す" }));
  await waitFor(() => expect(backend.docs.get("メモ/a.md")!.text).toBe("# A\n"));
  await waitFor(() => expect(screen.getByTestId("dirty")).toHaveTextContent("保存済み"));
  expect(screen.queryByRole("region", { name: "AI の変更" })).not.toBeInTheDocument();
  expect(await screen.findAllByText("AI の変更を元に戻しました。")).not.toHaveLength(0);
});

it("never undoes over an edit made after the change", async () => {
  mockStream();
  await openDocAndAi();
  await registerAndSend();
  const bar = await screen.findByRole("region", { name: "AI の変更" });
  const doc = backend.docs.get("メモ/a.md")!;
  doc.text += "[user]";
  doc.revision += 1;
  fireEvent.click(within(bar).getByRole("button", { name: "元に戻す" }));
  expect(await screen.findAllByText(/編集後のため戻していません/)).not.toHaveLength(0);
  expect(doc.text).toBe("# A\n[適用][user]");
});

it("keeps a concurrent later user edit dirty after AI save", async () => {
  mockStream();
  await openDocAndAi();
  // A user edit landing between the AI save and the post-save snapshot must
  // survive with its newer revision instead of being overwritten as clean.
  backend.editAfterSave = "[user]";
  await registerAndSend();
  await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("isolation_approve", { copyId: "copy_1" }));
  await waitFor(() => expect(screen.getByTestId("dirty")).toHaveTextContent("未保存"));
  expect(screen.getByTestId("editor-primary")).toHaveTextContent("[user]");
});

it("displays ask proposals without staging", async () => {
  mockStream();
  await openDocAndAi();
  const sidebar = screen.getByTestId("ai-sidebar");
  // Ask mode: proposal displays, stage is refused.
  fireEvent.click(within(sidebar).getByRole("combobox", { name: "モード" }));
  fireEvent.click(screen.getByRole("option", { name: /相談/ }));
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
  backend.approveOverride = {
    copyId: "copy_1",
    outcomes: [
      { documentId: "doc_a", applied: true, revision: 1, error: null, rolledBack: false, rollbackError: null },
      { documentId: "doc_b", applied: false, revision: 0, error: null, rolledBack: false, rollbackError: null },
    ],
  };
  await registerAndSend();
  await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("isolation_approve", { copyId: "copy_1" }));
  const results = await screen.findByLabelText("承認結果");
  expect(results).toHaveTextContent(/a\.md.*適用/);
  expect(results).toHaveTextContent(/文書.*変更なし/);
  expect(screen.queryByText(/未適用/)).not.toBeInTheDocument();
  expect(screen.queryByText(/all-or-nothing/i)).not.toBeInTheDocument();
});

it("reports a rollback failure per document without all-or-nothing claims", async () => {
  mockStream();
  await openDocAndAi();
  backend.approveOverride = {
    copyId: "copy_1",
    outcomes: [
      { documentId: "doc_a", applied: false, revision: 0, error: "neovim error", rolledBack: true, rollbackError: "rollback failed" },
    ],
  };
  await registerAndSend();
  const results = await screen.findByLabelText("承認結果");
  expect(results).toHaveTextContent(/a\.md.*未適用/);
  expect(results).toHaveTextContent(/ロールバック済み/);
  expect(results).toHaveTextContent(/ロールバック失敗/);
  expect(await screen.findByText(/1 文書が未適用/)).toBeVisible();
  expect(screen.queryByText(/all-or-nothing/i)).not.toBeInTheDocument();
  expect(backend.docs.get("メモ/a.md")!.text).toBe("# A\n");
  expect(screen.queryByRole("region", { name: "AI の変更" })).not.toBeInTheDocument();
});

it("refuses a stale apply and keeps the document for resync", async () => {
  mockStream();
  await openDocAndAi();
  backend.approveStaleOnce = true;
  await registerAndSend();
  await screen.findByText(/再登録/);
  expect(backend.docs.get("メモ/a.md")!.text).toBe("# A\n");
  expect(screen.getByTestId("revision")).toHaveTextContent("リビジョン 0");
});

it("applies files an agent edited directly when its workspace reply is prose", async () => {
  mockStream();
  await openDocAndAi();
  const sidebar = screen.getByTestId("ai-sidebar");
  fireEvent.click(within(sidebar).getByRole("combobox", { name: "モード" }));
  fireEvent.click(screen.getByRole("option", { name: /文書編集/ }));
  fireEvent.change(within(sidebar).getByLabelText("プロンプト"), { target: { value: "直して" } });
  fireEvent.click(within(sidebar).getByRole("button", { name: "送信" }));
  await waitFor(() => expect(handler).not.toBeNull());
  emitDone();
  await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("isolation_approve", { copyId: "copy_1" }));
  expect(await screen.findByRole("region", { name: "AI の変更" })).toBeVisible();
  expect(screen.queryByText(/patch ブロックがありません/)).not.toBeInTheDocument();
});
