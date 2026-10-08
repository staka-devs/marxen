import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import App from "../../App";
import { readRuntimeStatus } from "../../lib/runtime";
import { invoke } from "@tauri-apps/api/core";

vi.mock("../../lib/runtime", () => ({ readRuntimeStatus: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const mockedInvoke = vi.mocked(invoke);

interface BackendDoc {
  id: string;
  path: string;
  text: string;
  revision: number;
  dirty: boolean;
  history: string[];
}

const scenario = {
  files: new Map<string, BackendDoc>(),
  conflictOnSave: false,
  configErrors: [] as string[],
  mode: "normal" as string,
  mappingResult: false as boolean,
};

function resetBackend() {
  scenario.files = new Map([
    ["メモ/a.md", { id: "doc_a", path: "メモ/a.md", text: "# A\n\n- [ ] task\n", revision: 0, dirty: false, history: ["# A\n\n- [ ] task\n"] }],
    ["メモ/b.md", { id: "doc_b", path: "メモ/b.md", text: "# B\n", revision: 0, dirty: false, history: ["# B\n"] }],
    ["README.md", { id: "doc_readme", path: "README.md", text: "# R\n", revision: 0, dirty: false, history: ["# R\n"] }],
  ]);
  scenario.conflictOnSave = false;
  scenario.configErrors = [];
  scenario.mode = "normal";
  scenario.mappingResult = false;
}

function docById(id: string): BackendDoc {
  const doc = [...scenario.files.values()].find((entry) => entry.id === id);
  if (!doc) throw { code: "unknown_document" };
  return doc;
}

function applyText(text: string, edits: Array<{ range: { start: number; end: number }; text: string }>): string {
  let out = text;
  for (let i = edits.length - 1; i >= 0; i -= 1) {
    const edit = edits[i];
    out = out.slice(0, edit.range.start) + edit.text + out.slice(edit.range.end);
  }
  return out;
}

function snapshotOf(doc: BackendDoc) {
  return { documentId: doc.id, revision: doc.revision, text: doc.text, dirty: doc.dirty };
}

function installBackend() {
  mockedInvoke.mockImplementation((command: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (command) {
      case "open_workspace":
        return Promise.resolve({ root: a.path });
      case "list_workspace": {
        const dir = a.path as string;
        if (dir === "") {
          return Promise.resolve([
            { path: "メモ", name: "メモ", directory: true, markdown: false },
            { path: "README.md", name: "README.md", directory: false, markdown: true },
          ]);
        }
        if (dir === "メモ") {
          return Promise.resolve([
            { path: "メモ/a.md", name: "a.md", directory: false, markdown: true },
            { path: "メモ/b.md", name: "b.md", directory: false, markdown: true },
          ]);
        }
        return Promise.resolve([]);
      }
      case "list_documents":
        return Promise.resolve([]);
      case "open_markdown": {
        const doc = scenario.files.get(a.path as string);
        if (!doc) throw { code: "not_found" };
        return Promise.resolve({ path: doc.path, snapshot: snapshotOf(doc) });
      }
      case "fetch_snapshot": {
        const doc = docById(a.documentId as string);
        return Promise.resolve(snapshotOf(doc));
      }
      case "apply_gui_edits": {
        const doc = docById(a.documentId as string);
        if (a.baseRevision !== doc.revision) throw { code: "contract", error: { code: "stale_revision", expected: doc.revision, received: a.baseRevision } };
        doc.text = applyText(doc.text, a.edits as Array<{ range: { start: number; end: number }; text: string }>);
        doc.revision += 1;
        doc.dirty = true;
        doc.history.push(doc.text);
        return Promise.resolve(snapshotOf(doc));
      }
      case "nvim_input": {
        const doc = docById(a.documentId as string);
        if (a.baseRevision !== doc.revision) throw { code: "contract", error: { code: "stale_revision", expected: doc.revision, received: a.baseRevision } };
        doc.revision += 1;
        doc.dirty = true;
        doc.history.push(doc.text);
        return Promise.resolve(snapshotOf(doc));
      }
      case "undo_document": {
        const doc = docById(a.documentId as string);
        if (doc.history.length > 1) {
          doc.history.pop();
          doc.text = doc.history[doc.history.length - 1];
          doc.revision += 1;
          doc.dirty = true;
        }
        return Promise.resolve(snapshotOf(doc));
      }
      case "redo_document": {
        const doc = docById(a.documentId as string);
        return Promise.resolve(snapshotOf(doc));
      }
      case "save_document": {
        const doc = docById(a.documentId as string);
        if (scenario.conflictOnSave) throw { code: "conflict", path: doc.path };
        if (a.baseRevision !== doc.revision) throw { code: "contract", error: { code: "stale_revision", expected: doc.revision, received: a.baseRevision } };
        doc.dirty = false;
        return Promise.resolve({ documentId: doc.id, revision: doc.revision, dirty: false });
      }
      case "reload_document": {
        const doc = docById(a.documentId as string);
        if (doc.dirty) throw { code: "unsaved_changes", snapshot: snapshotOf(doc) };
        doc.revision += 1;
        return Promise.resolve(snapshotOf(doc));
      }
      case "close_document":
        return Promise.resolve(true);
      case "search_workspace": {
        const query = a.query as string;
        const matches = [];
        for (const doc of scenario.files.values()) {
          let from = 0;
          for (;;) {
            const idx = doc.text.indexOf(query, from);
            if (idx < 0) break;
            matches.push({ path: doc.path, documentId: doc.id, revision: doc.revision, range: { start: idx, end: idx + query.length }, line: 0, preview: doc.text.slice(idx, idx + 40) });
            from = idx + query.length;
          }
        }
        return Promise.resolve(matches);
      }
      case "poll_workspace_events":
        return Promise.resolve([]);
      case "list_recovery":
        return Promise.resolve([]);
      case "fetch_mode": {
        const doc = docById(a.documentId as string);
        return Promise.resolve({ documentId: doc.id, revision: doc.revision, mode: scenario.mode });
      }
      case "has_nvim_mapping":
        return Promise.resolve(scenario.mappingResult);
      case "fetch_cursor": {
        const doc = docById(a.documentId as string);
        return Promise.resolve({ documentId: doc.id, revision: doc.revision, anchor: 0, head: 0 });
      }
      case "report_cursor":
        return Promise.resolve({ documentId: a.documentId, revision: a.revision, anchor: a.anchor, head: a.head });
      case "fetch_grid": {
        const doc = docById(a.documentId as string);
        return Promise.resolve({ documentId: doc.id, revision: doc.revision, updates: [] });
      }
      case "configure_document":
        return Promise.resolve({ path: (a.path as string | null) ?? null, errors: scenario.configErrors });
      case "fetch_config":
        return Promise.resolve({ path: null, errors: [] });
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  resetBackend();
  installBackend();
  vi.mocked(readRuntimeStatus).mockResolvedValue({ contractVersion: 1, connection: "connected", detail: "connected" });
});

async function openWorkspace() {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "パスを入力する" }));
  fireEvent.change(screen.getByLabelText("開くフォルダーの絶対パス"), { target: { value: "/ws" } });
  fireEvent.click(screen.getByRole("button", { name: "開く" }));
  await screen.findByRole("button", { name: "メモ/a.md" });
}

it("preserves document IDs across tabs and tracks revisions", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await waitFor(() => expect(screen.getByTestId("revision")).toHaveTextContent("リビジョン 0"));
  fireEvent.click(screen.getByRole("button", { name: "メモ/b.md" }));
  await screen.findByText("# B");
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await screen.findByText("# A");
  const opens = mockedInvoke.mock.calls.filter(([command]) => command === "open_markdown");
  expect(opens.map(([, args]) => (args as Record<string, unknown>).path)).toEqual(["メモ/a.md", "メモ/b.md", "メモ/a.md"]);
  // Same registry ID every time; tabs show both files.
  expect(screen.getByTestId("tabs")).toHaveTextContent("a.md");
  expect(screen.getByTestId("tabs")).toHaveTextContent("b.md");
});

it("sends GUI edits with the live revision and native undo reverts them", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await screen.findByText("# A");
  // Cursor at document start: line 0 is the "# A" heading, checkbox toggles by prefixing.
  fireEvent.click(screen.getByRole("button", { name: "その他の操作" }));
  fireEvent.click(screen.getByRole("button", { name: "チェックリストを切り替える" }));
  await waitFor(() => expect(screen.getByTestId("revision")).toHaveTextContent("リビジョン 1"));
  expect(screen.getByTestId("dirty")).toHaveTextContent("未保存");
  const apply = mockedInvoke.mock.calls.find(([command]) => command === "apply_gui_edits");
  expect(apply?.[1]).toMatchObject({ documentId: "doc_a", baseRevision: 0 });
  fireEvent.click(screen.getByRole("button", { name: "元に戻す" }));
  await waitFor(() => expect(screen.getByTestId("revision")).toHaveTextContent("リビジョン 2"));
  expect(mockedInvoke).toHaveBeenCalledWith("undo_document", { documentId: "doc_a" });
});

it("resyncs stale revisions from the fresh snapshot", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await screen.findByText("# A");
  // Simulate Vim-side drift behind the shell's back.
  const doc = scenario.files.get("メモ/a.md")!;
  doc.text += "drift\n";
  doc.revision += 1;
  doc.dirty = true;
  fireEvent.click(screen.getByRole("button", { name: "その他の操作" }));
  fireEvent.click(screen.getByRole("button", { name: "チェックリストを切り替える" }));
  await screen.findByText(/再同期/);
  expect(screen.getByTestId("revision")).toHaveTextContent("リビジョン 1");
});

it("routes Vim keys serially with the live revision", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await screen.findByText("# A");
  const editor = screen.getByTestId("editor-primary");
  fireEvent.keyDown(editor, { key: "j" });
  await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("nvim_input", { documentId: "doc_a", baseRevision: 0, keys: "j" }));
  expect(screen.getByTestId("vim-keys")).toHaveTextContent("Vim入力");
});

it("asks save/discard/cancel before closing a dirty tab", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await screen.findByText("# A");
  fireEvent.click(screen.getByRole("button", { name: "その他の操作" }));
  fireEvent.click(screen.getByRole("button", { name: "チェックリストを切り替える" }));
  await waitFor(() => expect(screen.getByTestId("dirty")).toHaveTextContent("未保存"));
  const tabs = within(screen.getByTestId("tabs"));
  fireEvent.click(tabs.getByRole("button", { name: "a.mdを閉じる" }));
  await screen.findByTestId("close-dialog");
  fireEvent.click(screen.getByRole("button", { name: "破棄して閉じる" }));
  await waitFor(() => expect(screen.queryByTestId("close-dialog")).not.toBeInTheDocument());
  expect(mockedInvoke).toHaveBeenCalledWith("close_document", { documentId: "doc_a", baseRevision: 1, action: "discard" });
  expect(screen.getByTestId("tabs")).not.toHaveTextContent("a.md");
});

it("keeps text and shows the conflict UI when save loses", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await screen.findByText("# A");
  fireEvent.click(screen.getByRole("button", { name: "その他の操作" }));
  fireEvent.click(screen.getByRole("button", { name: "チェックリストを切り替える" }));
  await waitFor(() => expect(screen.getByTestId("dirty")).toHaveTextContent("未保存"));
  scenario.conflictOnSave = true;
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByTestId("conflict-banner");
  expect(screen.getByTestId("conflict-banner")).toHaveTextContent("本文は保持");
  expect(screen.getByTestId("dirty")).toHaveTextContent("未保存");
});

it("opens the natively picked folder instead of a typed prompt", async () => {
  const { open } = await import("@tauri-apps/plugin-dialog");
  vi.mocked(open).mockResolvedValueOnce("/picked/ws");
  render(<App />);
  fireEvent.click(screen.getAllByRole("button", { name: "フォルダーを開く" })[0]);
  await screen.findByRole("button", { name: "メモ/a.md" });
  expect(mockedInvoke).toHaveBeenCalledWith("open_workspace", { path: "/picked/ws" });
  // Clean chrome shows the root in the explorer; the manual path field stays
  // collapsed until explicitly requested.
  expect(screen.getByText("/picked/ws")).toBeVisible();
});

it("picks the config file natively and applies it with restart", async () => {
  const { open } = await import("@tauri-apps/plugin-dialog");
  vi.mocked(open).mockResolvedValueOnce("/cfg/init.lua");
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await screen.findByText("# A");
  fireEvent.click(screen.getByRole("button", { name: "設定表示切替" }));
  fireEvent.click(screen.getByRole("button", { name: "設定ファイルを参照する" }));
  await waitFor(() => expect(screen.getByLabelText("Neovim 設定ファイルのパス")).toHaveValue("/cfg/init.lua"));
  fireEvent.click(screen.getByRole("button", { name: "設定を適用して再起動する" }));
  await waitFor(() =>
    expect(mockedInvoke).toHaveBeenCalledWith("configure_document", {
      documentId: "doc_a",
      baseRevision: 0,
      path: "/cfg/init.lua",
    }),
  );
  await screen.findByText(/再起動しました/);
});

it("refreshes the runtime status when documents open", async () => {
  vi.mocked(readRuntimeStatus).mockReset();
  let releaseFirst!: (status: { contractVersion: number; connection: "disconnected"; detail: string }) => void;
  vi.mocked(readRuntimeStatus).mockImplementationOnce(
    () => new Promise((resolve) => { releaseFirst = resolve; }),
  );
  vi.mocked(readRuntimeStatus).mockResolvedValue({ contractVersion: 1, connection: "connected", detail: "live" });
  render(<App />);
  releaseFirst({ contractVersion: 1, connection: "disconnected", detail: "empty" });
  expect(await screen.findByText("Neovim 未接続")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "パスを入力する" }));
  fireEvent.change(screen.getByLabelText("開くフォルダーの絶対パス"), { target: { value: "/ws" } });
  fireEvent.click(screen.getByRole("button", { name: "開く" }));
  await screen.findByRole("button", { name: "メモ/a.md" });
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Neovim 接続済み"));
});

it("mounts the AI panel with the exact document scope", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await screen.findByText("# A");
  fireEvent.click(screen.getByRole("button", { name: "AI 支援" }));
  const sidebar = await screen.findByTestId("ai-sidebar");
  expect(within(sidebar).getByText(/doc_a rev 0/)).toBeVisible();
  expect(within(sidebar).getByText(/未解決/)).toBeVisible();
});

it("keeps display-basis arrows in the editor and routes Vim keys natively", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await screen.findByText("# A");
  fireEvent.click(screen.getByRole("button", { name: "その他の操作" }));
  fireEvent.click(screen.getByRole("button", { name: "表示基準" }));
  const editor = screen.getByTestId("editor-primary");
  fireEvent.keyDown(editor, { key: "ArrowDown" });
  fireEvent.keyDown(editor, { key: "Process" });
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "nvim_input")).toHaveLength(0);
  fireEvent.keyDown(editor, { key: "j" });
  await waitFor(() =>
    expect(mockedInvoke).toHaveBeenCalledWith("nvim_input", { documentId: "doc_a", baseRevision: 0, keys: "j" }),
  );
});

it("routes claimed insert keys natively and unclaimed keys as GUI inserts", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await screen.findByText("# A");
  scenario.mode = "insert";
  // Refresh the shell's mode snapshot through any mutation.
  fireEvent.click(screen.getByRole("button", { name: "メモ/b.md" }));
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await waitFor(() => expect(screen.getByTestId("vim-footer-mode")).toHaveTextContent("挿入"));
  const editor = screen.getByTestId("editor-primary");
  scenario.mappingResult = true;
  fireEvent.keyDown(editor, { key: "j" });
  await waitFor(() =>
    expect(mockedInvoke).toHaveBeenCalledWith("has_nvim_mapping", { documentId: "doc_a", mode: "i", lhs: "j" }),
  );
  await waitFor(() =>
    expect(mockedInvoke).toHaveBeenCalledWith("nvim_input", { documentId: "doc_a", baseRevision: 0, keys: "j" }),
  );
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(0);
  scenario.mappingResult = false;
  fireEvent.keyDown(editor, { key: "x" });
  await waitFor(() =>
    expect(mockedInvoke).toHaveBeenCalledWith(
      "apply_gui_edits",
      expect.objectContaining({ documentId: "doc_a", edits: [{ range: { start: 0, end: 0 }, text: "x" }] }),
    ),
  );
});

it("keeps fast insert bursts in source order", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await screen.findByText("# A");
  scenario.mode = "insert";
  fireEvent.click(screen.getByRole("button", { name: "メモ/b.md" }));
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await waitFor(() => expect(screen.getByTestId("vim-footer-mode")).toHaveTextContent("挿入"));
  scenario.mappingResult = false;
  const editor = screen.getByTestId("editor-primary");
  fireEvent.keyDown(editor, { key: "a" });
  fireEvent.keyDown(editor, { key: "b" });
  fireEvent.keyDown(editor, { key: "c" });
  await waitFor(() => expect(screen.getByTestId("revision")).toHaveTextContent("リビジョン 3"));
  expect(scenario.files.get("メモ/a.md")!.text.startsWith("abc")).toBe(true);
});

const readText = vi.fn();

function mockClipboard(text: string) {
  Object.defineProperty(window.navigator, "clipboard", { value: { readText }, configurable: true });
  readText.mockResolvedValue(text);
}

async function openInsertDoc() {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await screen.findByText("# A");
  scenario.mode = "insert";
  fireEvent.click(screen.getByRole("button", { name: "メモ/b.md" }));
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await waitFor(() => expect(screen.getByTestId("vim-footer-mode")).toHaveTextContent("挿入"));
}

it("lands unmapped insert paste as one insert without duplicating the DOM paste", async () => {
  mockClipboard("貼付😀\n2行目");
  await openInsertDoc();
  scenario.mappingResult = false;
  const editor = screen.getByTestId("editor-primary");
  fireEvent.keyDown(editor, { key: "v", ctrlKey: true });
  await waitFor(() =>
    expect(mockedInvoke).toHaveBeenCalledWith(
      "apply_gui_edits",
      expect.objectContaining({
        documentId: "doc_a",
        edits: [{ range: { start: 0, end: 0 }, text: "貼付😀\n2行目" }],
      }),
    ),
  );
  // The follow-up DOM paste must not insert a second time.
  fireEvent.paste(editor);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(1);
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "nvim_input")).toHaveLength(0);
  expect(scenario.files.get("メモ/a.md")!.text.startsWith("貼付😀\n2行目")).toBe(true);
});

it("routes explicitly mapped insert paste natively", async () => {
  mockClipboard("貼付");
  await openInsertDoc();
  scenario.mappingResult = true;
  const editor = screen.getByTestId("editor-primary");
  fireEvent.keyDown(editor, { key: "v", ctrlKey: true });
  await waitFor(() =>
    expect(mockedInvoke).toHaveBeenCalledWith("nvim_input", { documentId: "doc_a", baseRevision: 0, keys: "<C-v>" }),
  );
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(0);
});

it("keeps normal-mode Ctrl+V as native visual-block without a mapping query", async () => {
  mockClipboard("貼付");
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await screen.findByText("# A");
  const editor = screen.getByTestId("editor-primary");
  fireEvent.keyDown(editor, { key: "v", ctrlKey: true });
  await waitFor(() =>
    expect(mockedInvoke).toHaveBeenCalledWith("nvim_input", { documentId: "doc_a", baseRevision: 0, keys: "<C-v>" }),
  );
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "has_nvim_mapping")).toHaveLength(0);
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(0);
});
