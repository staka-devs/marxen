import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import App from "../../App";
import { readRuntimeStatus } from "../../infrastructure/tauri/runtime-client";
import { clearImageCache } from "../../infrastructure/images/image-loader";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { EditorView } from "@codemirror/view";

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
  applyStaleOnce: false,
  deferApplies: false,
  deferredReleases: [] as Array<() => void>,
  deferCursor: false,
  deferredCursorReleases: [] as Array<() => void>,
  cursorResponses: [] as Array<{ anchor: number; head: number }>,
  deferNextMode: false,
  deferredModeReleases: [] as Array<() => void>,
  deferNextOpen: false,
  deferredOpenReleases: [] as Array<() => void>,
  imageBytes: new Map<string, { mime: string; bytes: number[] }>(),
  pasteImageStaleOnce: false,
  pastedImages: [] as Array<{ documentId: string; name: string; range: { start: number; end: number } }>,
  recovery: [] as Array<{ documentId: string; path: string; revision: number; conflict: boolean }>,
};

/** Reset the fake native backend to three sample documents. */ function resetBackend() {
  scenario.files = new Map([
    ["メモ/a.md", { id: "doc_a", path: "メモ/a.md", text: "# A\n\n- [ ] task\n", revision: 0, dirty: false, history: ["# A\n\n- [ ] task\n"] }],
    ["メモ/b.md", { id: "doc_b", path: "メモ/b.md", text: "# B\n", revision: 0, dirty: false, history: ["# B\n"] }],
    ["README.md", { id: "doc_readme", path: "README.md", text: "# R\n", revision: 0, dirty: false, history: ["# R\n"] }],
  ]);
  scenario.conflictOnSave = false;
  scenario.configErrors = [];
  scenario.mode = "normal";
  scenario.mappingResult = false;
  scenario.applyStaleOnce = false;
  scenario.deferApplies = false;
  scenario.deferredReleases = [];
  scenario.deferCursor = false;
  scenario.deferredCursorReleases = [];
  scenario.cursorResponses = [];
  scenario.deferNextMode = false;
  scenario.deferredModeReleases = [];
  scenario.deferNextOpen = false;
  scenario.deferredOpenReleases = [];
  scenario.imageBytes = new Map();
  scenario.pasteImageStaleOnce = false;
  scenario.pastedImages = [];
  scenario.recovery = [];
}

/** Find a backend document by ID, rejecting unknown documents. */ function docById(id: string): BackendDoc {
  const doc = [...scenario.files.values()].find((entry) => entry.id === id);
  if (!doc) throw { code: "unknown_document" };
  return doc;
}

/** Apply range edits tail-first to fake backend text. */ function applyText(text: string, edits: Array<{ range: { start: number; end: number }; text: string }>): string {
  let out = text;
  for (let i = edits.length - 1; i >= 0; i -= 1) {
    const edit = edits[i];
    out = out.slice(0, edit.range.start) + edit.text + out.slice(edit.range.end);
  }
  return out;
}

/** Build a snapshot payload from a backend document. */ function snapshotOf(doc: BackendDoc) {
  return { documentId: doc.id, revision: doc.revision, text: doc.text, dirty: doc.dirty };
}

/** Install the fake Tauri backend answering workspace commands. */ function installBackend() {
  mockedInvoke.mockImplementation((command: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (command) {
      case "open_workspace":
        return Promise.resolve({ root: a.path, scope: { rootId: "fixture-root", generation: "1" } });
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
        if (scenario.deferNextOpen) {
          scenario.deferNextOpen = false;
          const answer = { path: doc.path, snapshot: snapshotOf(doc) };
          return new Promise((resolve) => scenario.deferredOpenReleases.push(() => resolve(answer)));
        }
        return Promise.resolve({ path: doc.path, snapshot: snapshotOf(doc) });
      }
      case "fetch_snapshot": {
        const doc = docById(a.documentId as string);
        return Promise.resolve(snapshotOf(doc));
      }
      case "apply_gui_edits": {
        const doc = docById(a.documentId as string);
        if (scenario.applyStaleOnce) {
          scenario.applyStaleOnce = false;
          throw { code: "contract", error: { code: "stale_revision", expected: doc.revision + 1, received: a.baseRevision } };
        }
        if (a.baseRevision !== doc.revision) throw { code: "contract", error: { code: "stale_revision", expected: doc.revision, received: a.baseRevision } };
        doc.text = applyText(doc.text, a.edits as Array<{ range: { start: number; end: number }; text: string }>);
        doc.revision += 1;
        doc.dirty = true;
        doc.history.push(doc.text);
        if (scenario.deferApplies) {
          // Mutate now but acknowledge later: every keystroke queues against
          // event-time ranges before any acknowledgment lands.
          return new Promise((resolve) => {
            scenario.deferredReleases.push(() => resolve(snapshotOf(doc)));
          });
        }
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
      case "nvim_input_with_copy": {
        const doc = docById(a.documentId as string);
        if (a.baseRevision !== doc.revision) throw { code: "contract", error: { code: "stale_revision", expected: doc.revision, received: a.baseRevision } };
        doc.revision += 1;
        doc.dirty = true;
        doc.history.push(doc.text);
        return Promise.resolve({ snapshot: snapshotOf(doc), copy: null, copyReady: false });
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
      case "fetch_editor_context": {
        const doc = docById(a.documentId as string);
        if (a.baseRevision !== doc.revision) throw { code: "contract", error: { code: "stale_revision", expected: doc.revision, received: a.baseRevision } };
        return Promise.resolve({ cursor: { documentId: doc.id, revision: doc.revision, anchor: 0, head: 0 }, mode: scenario.mode, presentation: { editable: true, selectionToolbar: false, mappings: [] } });
      }
      case "editor_history": {
        const doc = docById(a.documentId as string);
        if (a.baseRevision !== doc.revision) throw { code: "contract", error: { code: "stale_revision", expected: doc.revision, received: a.baseRevision } };
        if (!a.redo && doc.history.length > 1) { doc.history.pop(); doc.text = doc.history[doc.history.length - 1]; doc.revision += 1; doc.dirty = true; }
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
        return Promise.resolve(scenario.recovery);
      case "fetch_mode": {
        const doc = docById(a.documentId as string);
        if (scenario.deferNextMode) {
          scenario.deferNextMode = false;
          const answer = { documentId: doc.id, revision: doc.revision, mode: scenario.mode };
          return new Promise((resolve) => scenario.deferredModeReleases.push(() => resolve(answer)));
        }
        return Promise.resolve({ documentId: doc.id, revision: doc.revision, mode: scenario.mode });
      }
      case "has_nvim_mapping":
        return Promise.resolve(scenario.mappingResult);
      case "fetch_cursor": {
        const doc = docById(a.documentId as string);
        if (scenario.deferCursor) {
          // Park the native cursor answer so the test can release a newer
          // response before an older one and prove the older cannot reset it.
          // Each parked call captures its own response up front.
          const mine = scenario.cursorResponses.shift() ?? { anchor: 0, head: 0 };
          return new Promise((resolve) => {
            scenario.deferredCursorReleases.push(() => {
              resolve({ documentId: doc.id, revision: doc.revision, anchor: mine.anchor, head: mine.head });
            });
          });
        }
        return Promise.resolve({ documentId: doc.id, revision: doc.revision, anchor: 0, head: 0 });
      }
      case "report_cursor":
        return Promise.resolve({ documentId: a.documentId, revision: a.revision, anchor: a.anchor, head: a.head });
      case "load_relative_image": {
        const key = `${a.documentId as string}:${a.path as string}`;
        const found = scenario.imageBytes.get(key);
        if (!found) throw { code: "not_found" };
        return Promise.resolve(found);
      }
      case "paste_image": {
        const request = a as unknown as { documentId: string; baseRevision: number; name: string; range: { start: number; end: number } };
        const doc = docById(request.documentId);
        if (scenario.pasteImageStaleOnce) {
          scenario.pasteImageStaleOnce = false;
          return Promise.reject({ code: "contract", error: { code: "stale_revision", expected: doc.revision, received: request.baseRevision } });
        }
        if (request.baseRevision !== doc.revision) {
          throw { code: "contract", error: { code: "stale_revision", expected: doc.revision, received: request.baseRevision } };
        }
        scenario.pastedImages.push({ documentId: request.documentId, name: request.name as string, range: request.range });
        doc.text += `\n![${request.name}](images/${request.name})\n`;
        doc.revision += 1;
        doc.dirty = true;
        doc.history.push(doc.text);
        return Promise.resolve({ path: `images/${request.name}`, snapshot: snapshotOf(doc) });
      }
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
  clearImageCache();
  resetBackend();
  installBackend();
  vi.mocked(readRuntimeStatus).mockResolvedValue({ contractVersion: 1, connection: "connected", detail: "connected" });
});

it("binds native search options and localized errors through the composed App shell", async () => {
  await openWorkspace();
  const backend = mockedInvoke.getMockImplementation()!;
  mockedInvoke.mockImplementation(async (command, args) => {
    if (command === "search_workspace") {
      if ((args as { query: string }).query === "[") throw { code: "search_pattern" };
      return { matches: [], limit: null };
    }
    return backend(command, args);
  });
  fireEvent.click(screen.getByRole("button", { name: "検索" }));
  const panel = within(screen.getByTestId("search-panel"));
  fireEvent.change(panel.getByLabelText("検索語句"), { target: { value: "cat" } });
  fireEvent.click(panel.getByRole("button", { name: "大文字と小文字を区別" }));
  fireEvent.click(panel.getByRole("button", { name: "単語単位で検索" }));
  fireEvent.click(panel.getByRole("button", { name: "正規表現で検索" }));
  await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("search_workspace", {
    scope: { rootId: "fixture-root", generation: "1" },
    query: "cat", root: "/ws", options: { caseSensitive: true, wholeWord: true, regex: true },
  }));
  expect(panel.getByRole("button", { name: "正規表現で検索" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.change(panel.getByLabelText("検索語句"), { target: { value: "[" } });
  expect(await panel.findByRole("alert")).toHaveTextContent("検索パターンが不正");
  expect(panel.queryByRole("button", { name: "すべて置換する" })).not.toBeInTheDocument();
  fireEvent.click(panel.getByRole("button", { name: "置換を表示する" }));
  expect(panel.getByRole("button", { name: "すべて置換する" })).toBeDisabled();
});

/** Open the fake workspace through the manual folder input. */
async function openWorkspace() {
  render(<App />);
  fireEvent.click(screen.getByRole("menuitem", { name: "ファイル" }));
  await waitFor(() => expect(screen.getByRole("menuitem", { name: "パスを入力する" })).toBeEnabled());
  fireEvent.click(screen.getByRole("menuitem", { name: "パスを入力する" }));
  fireEvent.change(screen.getByLabelText("開くフォルダーの絶対パス"), { target: { value: "/ws" } });
  fireEvent.click(screen.getByRole("button", { name: "開く" }));
  await screen.findByRole("button", { name: "メモ/a.md" });
}

it("preserves document IDs across tabs and tracks revisions", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await waitFor(() => expect(screen.getByTestId("revision")).toHaveTextContent("リビジョン 0"));
  fireEvent.click(screen.getByRole("button", { name: "メモ/b.md" }));
  await vi.waitFor(() => expect(screen.getByTestId("editor-primary")).toHaveTextContent("# B"));
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await vi.waitFor(() => expect(screen.getByTestId("editor-primary")).toHaveTextContent("# A"));
  const opens = mockedInvoke.mock.calls.filter(([command]) => command === "open_markdown");
  expect(opens.map(([, args]) => (args as Record<string, unknown>).path)).toEqual(["メモ/a.md", "メモ/b.md", "メモ/a.md"]);
  // Same registry ID every time; tabs show both files.
  expect(screen.getByTestId("tabs")).toHaveTextContent("a.md");
  expect(screen.getByTestId("tabs")).toHaveTextContent("b.md");
});

it("sends GUI edits with the live revision and native undo reverts them", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await vi.waitFor(() => expect(screen.getByTestId("editor-primary")).toHaveTextContent("# A"));
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

it.each(["日本語", "日😀本a語"])("keeps a %s burst through delayed older GUI ACKs", async (burst) => {
  const initial = "abc\nx本文です\n";
  scenario.files.set("メモ/a.md", { id: "doc_a", path: "メモ/a.md", text: initial, revision: 0, dirty: false, history: [initial] });
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await waitFor(() => expect(screen.getByTestId("editor-primary")).toHaveTextContent("x本文です"));
  scenario.mode = "insert";
  fireEvent.click(screen.getByRole("button", { name: "メモ/b.md" }));
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await waitFor(() => expect(screen.getByTestId("vim-footer-mode")).toHaveTextContent("挿入"));
  scenario.deferApplies = true;
  const editorDom = screen.getByTestId("editor-primary").querySelector(".cm-editor")! as HTMLElement;
  const view = EditorView.findFromDOM(editorDom)!;
  expect(view).not.toBeNull();
  let offset = 5;
  for (const char of burst) {
    if (char === "a") fireEvent.keyDown(view.contentDOM, { key: char });
    act(() => view.dispatch({ changes: { from: offset, to: offset, insert: char }, selection: { anchor: offset + char.length } }));
    if (char === "a") fireEvent.keyUp(view.contentDOM, { key: char });
    offset += char.length;
  }
  const expected = "abc\nx" + burst + "本文です\n";
  const count = [...burst].length;
  expect(view.state.doc.toString()).toBe(expected);
  await waitFor(() => expect(scenario.deferredReleases).toHaveLength(1));
  for (let revision = 1; revision <= count; revision += 1) {
    scenario.deferredReleases.shift()!();
    if (revision < count) {
      await waitFor(() => expect(scenario.deferredReleases).toHaveLength(1));
      expect(view.state.doc.toString()).toBe(expected);
      expect(screen.getByTestId("revision")).toHaveTextContent("リビジョン 0");
    }
  }
  await waitFor(() => expect(screen.getByTestId("revision")).toHaveTextContent("リビジョン " + count));
  expect(view.state.doc.toString()).toBe(expected);
  expect(scenario.files.get("メモ/a.md")!.text).toBe(expected);
});

it("resyncs stale revisions from the fresh snapshot", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await vi.waitFor(() => expect(screen.getByTestId("editor-primary")).toHaveTextContent("# A"));
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
  await vi.waitFor(() => expect(screen.getByTestId("editor-primary")).toHaveTextContent("# A"));
  const editor = screen.getByTestId("editor-primary");
  fireEvent.keyDown(editor, { key: "j" });
  await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("nvim_input_with_copy", { documentId: "doc_a", baseRevision: 0, keys: "j" }));
  expect(screen.getByTestId("vim-keys")).toHaveTextContent("Vim入力");
});

it("asks save/discard/cancel before closing a dirty tab", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await vi.waitFor(() => expect(screen.getByTestId("editor-primary")).toHaveTextContent("# A"));
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
  await vi.waitFor(() => expect(screen.getByTestId("editor-primary")).toHaveTextContent("# A"));
  fireEvent.click(screen.getByRole("button", { name: "その他の操作" }));
  fireEvent.click(screen.getByRole("button", { name: "チェックリストを切り替える" }));
  await waitFor(() => expect(screen.getByTestId("dirty")).toHaveTextContent("未保存"));
  scenario.conflictOnSave = true;
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByTestId("conflict-banner");
  expect(screen.getByTestId("conflict-banner")).toHaveTextContent("本文は保持");
  expect(screen.getByTestId("dirty")).toHaveTextContent("未保存");
});

it("uses the persisted anchor for save and external recovery toasts through App composition", async () => {
  localStorage.setItem("marxen.editor-preferences.v1", JSON.stringify({ notificationPosition: "top-center" }));
  await openWorkspace(); fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await screen.findByTestId("editor-primary");
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  const toast = await screen.findByTestId("notification-toast");
  expect(toast).toHaveTextContent("保存しました。"); expect(toast).toHaveAttribute("role", "status");
  expect(toast.parentElement).toBe(document.body);
  expect(screen.getByTestId("workspace-shell")).not.toContainElement(toast);
  expect(toast).toHaveClass("top-8", "left-1/2", "-translate-x-1/2");
  const subscription = vi.mocked(listen).mock.calls.find(([event]) => event === "marxen:workspace");
  expect(subscription).toBeDefined();
  act(() => subscription![1]({ event: "marxen:workspace", id: 1, payload: [{ scope: { rootId: "fixture-root", generation: "1" }, event: { type: "external_change", payload: { documentId: "doc_a", path: "メモ/a.md", dirty: false, deleted: false } } }] }));
  const external = await screen.findByTestId("external-banner");
  expect(external).toHaveTextContent("ファイルが外部で変更されました。");
  expect(external).toHaveClass("top-32", "left-1/2", "-translate-x-1/2");
  expect(external.parentElement).toBe(document.body);
  fireEvent.click(within(toast).getByRole("button", { name: "通知を閉じる" }));
  expect(external).toHaveClass("top-8");
  fireEvent.click(within(external).getByRole("button", { name: "再読込する" }));
  await waitFor(() => expect(screen.queryByTestId("external-banner")).not.toBeInTheDocument());
  expect(mockedInvoke).toHaveBeenCalledWith("reload_document", { documentId: "doc_a", baseRevision: 0 });
  localStorage.removeItem("marxen.editor-preferences.v1");
});

it("can postpone recovery without discarding documents and reopen the dialog", async () => {
  scenario.recovery = [{ documentId: "doc_a", path: "メモ/a.md", revision: 2, conflict: false }];
  await openWorkspace();
  const dialog = await screen.findByRole("dialog", { name: "未保存の文書を復元" });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  fireEvent.click(within(dialog).getByRole("button", { name: "後で" }));
  expect(screen.queryByRole("dialog", { name: "未保存の文書を復元" })).not.toBeInTheDocument();
  expect(mockedInvoke.mock.calls.some(([command]) => command === "discard_recovery")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "その他の操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "復旧一覧" }));
  await screen.findByRole("dialog", { name: "未保存の文書を復元" });
});

it("opens the natively picked folder instead of a typed prompt", async () => {
  const { open } = await import("@tauri-apps/plugin-dialog");
  vi.mocked(open).mockResolvedValueOnce("/picked/ws");
  render(<App />);
  fireEvent.click(screen.getByRole("menuitem", { name: "ファイル" }));
  await waitFor(() => expect(screen.getByRole("menuitem", { name: "フォルダーを開く" })).toBeEnabled());
  fireEvent.click(screen.getByRole("menuitem", { name: "フォルダーを開く" }));
  await screen.findByRole("button", { name: "メモ/a.md" });
  expect(mockedInvoke).toHaveBeenCalledWith("open_workspace", { path: "/picked/ws" });
  expect(screen.getByRole("button", { name: "ws" })).toBeVisible();
  expect(screen.getByTitle("/picked/ws")).toHaveTextContent("ws");
});

it("picks the config file natively and applies it with restart", async () => {
  const { open } = await import("@tauri-apps/plugin-dialog");
  vi.mocked(open).mockResolvedValueOnce("/cfg/init.lua");
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await vi.waitFor(() => expect(screen.getByTestId("editor-primary")).toHaveTextContent("# A"));
  fireEvent.click(screen.getByRole("button", { name: "設定表示切替" }));
  fireEvent.click(screen.getByRole("button", { name: /^Vim$/ }));
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
  fireEvent.click(screen.getByRole("menuitem", { name: "ファイル" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "パスを入力する" }));
  fireEvent.change(screen.getByLabelText("開くフォルダーの絶対パス"), { target: { value: "/ws" } });
  fireEvent.click(screen.getByRole("button", { name: "開く" }));
  await screen.findByRole("button", { name: "メモ/a.md" });
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Neovim 接続済み"));
});

it("mounts the AI panel with the exact document scope", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await vi.waitFor(() => expect(screen.getByTestId("editor-primary")).toHaveTextContent("# A"));
  expect(within(screen.getByRole("navigation", { name: "アクティビティ" })).queryByRole("button", { name: "チャットを切り替える" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "チャットを切り替える" }));
  const sidebar = await screen.findByTestId("ai-sidebar");
  expect(within(sidebar).getByText("a.md")).toBeVisible();
  expect(within(sidebar).getByLabelText("チャット")).toBeVisible();
  fireEvent.keyDown(window, { key: "i", ctrlKey: true, altKey: true });
  expect(sidebar).toHaveAttribute("aria-hidden", "true");
  fireEvent.keyDown(window, { key: "i", ctrlKey: true, altKey: true });
  expect(sidebar).toHaveAttribute("aria-hidden", "false");
});

it("keeps display-basis arrows in the editor and routes Vim keys natively", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await vi.waitFor(() => expect(screen.getByTestId("editor-primary")).toHaveTextContent("# A"));
  fireEvent.click(screen.getByRole("button", { name: "その他の操作" }));
  fireEvent.click(screen.getByRole("button", { name: "表示行" }));
  const editor = screen.getByTestId("editor-primary");
  fireEvent.keyDown(editor, { key: "ArrowDown" });
  fireEvent.keyDown(editor, { key: "Process" });
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "nvim_input")).toHaveLength(0);
  fireEvent.keyDown(editor, { key: "j" });
  await waitFor(() =>
    expect(mockedInvoke).toHaveBeenCalledWith("nvim_input_with_copy", { documentId: "doc_a", baseRevision: 0, keys: "j" }),
  );
});

it("keeps a mapping prefix native before returning unmapped keys to GUI edits", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await vi.waitFor(() => expect(screen.getByTestId("editor-primary")).toHaveTextContent("# A"));
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
  await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("nvim_input", { documentId: "doc_a", baseRevision: 1, keys: "x" }));
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(0);
  fireEvent.keyDown(editor, { key: "q" });
  await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("apply_gui_edits", expect.objectContaining({ documentId: "doc_a", edits: [{ range: { start: 0, end: 0 }, text: "q" }] })));
});

it("keeps fast insert bursts in source order", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await vi.waitFor(() => expect(screen.getByTestId("editor-primary")).toHaveTextContent("# A"));
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
  // Rapid bursts advance the collapsed caret so queued ranges keep order.
  const burstRanges = mockedInvoke.mock.calls
    .filter(([command]) => command === "apply_gui_edits")
    .map(([, args]) => (args as { edits: Array<{ range: { start: number; end: number } }> }).edits[0].range);
  expect(burstRanges).toEqual([
    { start: 0, end: 0 },
    { start: 1, end: 1 },
    { start: 2, end: 2 },
  ]);
});

it("keeps rapid input ordered on an empty document before any acknowledgment", async () => {
  const empty = "";
  scenario.files.set("メモ/a.md", { id: "doc_a", path: "メモ/a.md", text: empty, revision: 0, dirty: false, history: [empty] });
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  scenario.mode = "insert";
  fireEvent.click(screen.getByRole("button", { name: "メモ/b.md" }));
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await waitFor(() => expect(screen.getByTestId("vim-footer-mode")).toHaveTextContent("挿入"));
  scenario.mappingResult = false;
  scenario.deferApplies = true;
  const editor = screen.getByTestId("editor-primary");
  // All three ranges resolve before the first acknowledgment lands: a
  // clamped projection would send 0..0 three times and yield CBA.
  fireEvent.keyDown(editor, { key: "A" });
  fireEvent.keyDown(editor, { key: "B" });
  fireEvent.keyDown(editor, { key: "C" });
  // Drain the serial queue one acknowledgment at a time, in order.
  for (const expected of ["A", "AB", "ABC"]) {
    await waitFor(() => expect(scenario.deferredReleases.length).toBeGreaterThan(0));
    scenario.deferredReleases.shift()!();
    await waitFor(() => expect(scenario.files.get("メモ/a.md")!.text).toBe(expected));
  }
  scenario.deferApplies = false;
  await waitFor(() => expect(screen.getByTestId("revision")).toHaveTextContent("リビジョン 3"));
  // Native undo restores the exact previous text.
  fireEvent.click(screen.getByRole("button", { name: "その他の操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "コマンドパレット" }));
  await screen.findByTestId("command-palette");
  fireEvent.change(screen.getByLabelText("コマンドで絞り込む"), { target: { value: "元に戻す" } });
  fireEvent.click(await screen.findByText("編集: 元に戻す"));
  await waitFor(() => expect(scenario.files.get("メモ/a.md")!.text).toBe("AB"));
  await waitFor(() => expect(screen.getByTestId("revision")).toHaveTextContent("リビジョン 4"));
});

it("keeps rapid input ordered at EOF before any acknowledgment", async () => {
  const empty = "";
  scenario.files.set("メモ/a.md", { id: "doc_a", path: "メモ/a.md", text: empty, revision: 0, dirty: false, history: [empty] });
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  scenario.mode = "insert";
  fireEvent.click(screen.getByRole("button", { name: "メモ/b.md" }));
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await waitFor(() => expect(screen.getByTestId("vim-footer-mode")).toHaveTextContent("挿入"));
  scenario.mappingResult = false;
  const editor = screen.getByTestId("editor-primary");
  let built = "";
  for (const key of ["a", "b", "c"]) {
    fireEvent.keyDown(editor, { key });
    built += key;
    await waitFor(() => expect(scenario.files.get("メモ/a.md")!.text).toBe(built));
  }
  // Caret now sits at EOF (offset 3): the next burst must project past the
  // known length instead of clamping back to it (which would yield ZYX).
  scenario.deferApplies = true;
  fireEvent.keyDown(editor, { key: "X" });
  fireEvent.keyDown(editor, { key: "Y" });
  fireEvent.keyDown(editor, { key: "Z" });
  for (const expected of ["abcX", "abcXY", "abcXYZ"]) {
    await waitFor(() => expect(scenario.deferredReleases.length).toBeGreaterThan(0));
    scenario.deferredReleases.shift()!();
    await waitFor(() => expect(scenario.files.get("メモ/a.md")!.text).toBe(expected));
  }
  scenario.deferApplies = false;
});

it("types immediately after i without waiting for the mode echo", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await vi.waitFor(() => expect(screen.getByTestId("editor-primary")).toHaveTextContent("# A"));
  // Still Normal on screen: no mode echo has run since opening.
  expect(screen.getByTestId("vim-footer-mode")).toHaveTextContent("ノーマル");
  const editor = screen.getByTestId("editor-primary");
  fireEvent.keyDown(editor, { key: "i" });
  fireEvent.keyDown(editor, { key: "é" });
  fireEvent.keyDown(editor, { key: "<" });
  await waitFor(() => {
    const inputs = mockedInvoke.mock.calls.filter(([command]) => command === "nvim_input_with_copy");
    expect(inputs.map(([, args]) => (args as { keys: string }).keys)).toEqual(["i", "é", "<"]);
  });
  const bases = mockedInvoke.mock.calls
    .filter(([command]) => command === "nvim_input_with_copy")
    .map(([, args]) => (args as { baseRevision: number }).baseRevision);
  expect(bases).toEqual([0, 1, 2]);
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(0);
});

/** Open a document in insert mode for editing-behavior tests. */
async function openInsertDoc() {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await vi.waitFor(() => expect(screen.getByTestId("editor-primary")).toHaveTextContent("# A"));
  scenario.mode = "insert";
  fireEvent.click(screen.getByRole("button", { name: "メモ/b.md" }));
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await waitFor(() => expect(screen.getByTestId("vim-footer-mode")).toHaveTextContent("挿入"));
}

/**
 * Fire a synthetic paste event carrying text and optional files.
 *
 * Files default to empty so text-only and image pastes share one helper.
 */
function pasteEvent(editor: HTMLElement, text: string, files: File[] = []) {
  fireEvent.paste(editor, {
    clipboardData: {
      /** Return the pasted text for text mimetypes, else empty. */
      getData: (type: string) => (type.startsWith("text") ? text : ""),
      files,
    },
  });
}

it("lands unmapped keyboard paste as one insert exactly once", async () => {
  await openInsertDoc();
  scenario.mappingResult = false;
  const editor = screen.getByTestId("editor-primary");
  // Keyboard gesture first: the follow-up paste event carries the bytes.
  fireEvent.keyDown(editor, { key: "v", ctrlKey: true });
  pasteEvent(editor, "貼付😀\n2行目");
  await waitFor(() =>
    expect(mockedInvoke).toHaveBeenCalledWith(
      "apply_gui_edits",
      expect.objectContaining({
        documentId: "doc_a",
        edits: [{ range: { start: 0, end: 0 }, text: "貼付😀\n2行目" }],
      }),
    ),
  );
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(1);
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "nvim_input")).toHaveLength(0);
  expect(scenario.files.get("メモ/a.md")!.text.startsWith("貼付😀\n2行目")).toBe(true);
});

it("routes explicitly mapped keyboard paste natively", async () => {
  await openInsertDoc();
  scenario.mappingResult = true;
  const editor = screen.getByTestId("editor-primary");
  fireEvent.keyDown(editor, { key: "v", ctrlKey: true });
  pasteEvent(editor, "貼付");
  await waitFor(() =>
    expect(mockedInvoke).toHaveBeenCalledWith("nvim_input", { documentId: "doc_a", baseRevision: 0, keys: "<C-v>" }),
  );
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(0);
});

it("inserts context-menu paste directly without simulating a mapping", async () => {
  await openInsertDoc();
  scenario.mappingResult = true;
  const editor = screen.getByTestId("editor-primary");
  // No keyboard gesture: the paste must not query <C-v> mappings.
  pasteEvent(editor, "メニュー貼付");
  await waitFor(() =>
    expect(mockedInvoke).toHaveBeenCalledWith(
      "apply_gui_edits",
      expect.objectContaining({
        documentId: "doc_a",
        edits: [{ range: { start: 0, end: 0 }, text: "メニュー貼付" }],
      }),
    ),
  );
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "has_nvim_mapping")).toHaveLength(0);
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "nvim_input")).toHaveLength(0);
});

it("pastes an OS image with empty text exactly once without text insertion", async () => {
  await openInsertDoc();
  scenario.mappingResult = false;
  const editor = screen.getByTestId("editor-primary");
  const file = {
    name: "shot.png",
    type: "image/png",
    size: 4,
    /** PNG bytes for single-image paste tests. */
    arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
  } as unknown as File;
  fireEvent.keyDown(editor, { key: "v", ctrlKey: true });
  pasteEvent(editor, "", [file]);
  await waitFor(() => expect(scenario.pastedImages).toHaveLength(1));
  expect(scenario.pastedImages[0]).toMatchObject({ documentId: "doc_a", name: "shot.png" });
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(0);
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "nvim_input")).toHaveLength(0);
});

it("appends each pasted image after the previous insert instead of reusing one offset", async () => {
  await openInsertDoc();
  const editor = screen.getByTestId("editor-primary");
  const first = {
    name: "one.png",
    type: "image/png",
    size: 4,
    /** First bytes for chained multi-image paste tests. */
    arrayBuffer: async () => new Uint8Array([1]).buffer,
  } as unknown as File;
  const second = {
    name: "two.png",
    type: "image/png",
    size: 4,
    /** Second bytes for chained multi-image paste tests. */
    arrayBuffer: async () => new Uint8Array([2]).buffer,
  } as unknown as File;
  fireEvent.keyDown(editor, { key: "v", ctrlKey: true });
  pasteEvent(editor, "", [first, second]);
  await waitFor(() => expect(scenario.pastedImages).toHaveLength(2));
  const [firstCall, secondCall] = scenario.pastedImages;
  expect(firstCall.range).toEqual({ start: 0, end: 0 });
  expect(secondCall.range.start).toBeGreaterThan(firstCall.range.start);
  expect(secondCall.range.start).toBe(secondCall.range.end);
});

/** Open a document in display-basis source mode for offset-exact tests. */
async function openInsertDocDisplay() {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await screen.findByTestId("editor-primary");
  scenario.mode = "insert";
  fireEvent.click(screen.getByRole("button", { name: "メモ/b.md" }));
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await waitFor(() => expect(screen.getByTestId("vim-footer-mode")).toHaveTextContent("挿入"));
  // Display basis lets arrows stay local; source mode keeps the editor a
  // plain text surface (no live widgets) so DOM offsets equal source offsets.
  fireEvent.change(screen.getByLabelText("表示モード"), { target: { value: "source" } });
  fireEvent.click(screen.getByRole("button", { name: "その他の操作" }));
  fireEvent.click(screen.getByRole("button", { name: "表示行" }));
}

/** Drive a real editor selection through the DOM selection observer. */
async function selectEditorRange(anchorLine: number, anchorOffset: number, headLine: number, headOffset: number) {
  const content = screen.getByTestId("editor-primary").querySelector(".cm-content")! as HTMLElement;
  // CodeMirror only honors selections while focused, and discards a selection
  // at element start made within its focus-settle window: focus once, wait it
  // out, then select.
  content.focus();
  await new Promise((resolve) => setTimeout(resolve, 350));
  const lines = screen.getByTestId("editor-primary").querySelectorAll(".cm-line");
  const anchorNode = lines[anchorLine].firstChild!;
  const headNode = lines[headLine].firstChild!;
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.setBaseAndExtent(anchorNode, anchorOffset, headNode, headOffset);
  document.dispatchEvent(new Event("selectionchange", { bubbles: false }));
}

it("preserves an Insert selection across refresh and replaces it exactly once", async () => {
  const text = "ab😀XY\n12";
  scenario.files.set("メモ/a.md", { id: "doc_a", path: "メモ/a.md", text, revision: 0, dirty: false, history: [text] });
  await openInsertDocDisplay();
  scenario.mappingResult = false;
  const editor = screen.getByTestId("editor-primary");
  // Forward selection [0,7] = "ab😀XY\n" across emoji and newline.
  await selectEditorRange(0, 0, 1, 0);
  await waitFor(() => expect(screen.getByTestId("cursor")).toHaveTextContent("カーソル 2:1"));
  // The native cursor recomputes collapsed in Insert: stage the report and
  // let every async refresh settle, then the range must still be intact.
  await waitFor(() =>
    expect(mockedInvoke).toHaveBeenCalledWith(
      "report_cursor",
      expect.objectContaining({ documentId: "doc_a", anchor: 0, head: 7 }),
    ),
  );
  await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("fetch_cursor", { documentId: "doc_a" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.getByTestId("cursor")).toHaveTextContent("カーソル 2:1");
  fireEvent.keyDown(editor, { key: "Q" });
  await waitFor(() =>
    expect(mockedInvoke).toHaveBeenCalledWith(
      "apply_gui_edits",
      expect.objectContaining({ documentId: "doc_a", edits: [{ range: { start: 0, end: 7 }, text: "Q" }] }),
    ),
  );
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(1);
  expect(scenario.files.get("メモ/a.md")!.text).toBe("Q12");
  // Reverse selection [1,0] over the same span start replaces identically.
  await selectEditorRange(0, 1, 0, 0);
  await waitFor(() => expect(screen.getByTestId("cursor")).toHaveTextContent("カーソル 1:1"));
  fireEvent.keyDown(screen.getByTestId("editor-primary"), { key: "Z" });
  await waitFor(() =>
    expect(mockedInvoke).toHaveBeenCalledWith(
      "apply_gui_edits",
      expect.objectContaining({ documentId: "doc_a", edits: [{ range: { start: 0, end: 1 }, text: "Z" }] }),
    ),
  );
  expect(scenario.files.get("メモ/a.md")!.text).toBe("Z12");
});

it("does not restore an old Insert selection after a newer character was applied", async () => {
  const text = "ab😀XY\n12";
  scenario.files.set("メモ/a.md", { id: "doc_a", path: "メモ/a.md", text, revision: 0, dirty: false, history: [text] });
  await openInsertDocDisplay();
  const editor = screen.getByTestId("editor-primary");
  (editor.querySelector(".cm-content") as HTMLElement).focus();
  await new Promise((resolve) => setTimeout(resolve, 400));
  scenario.deferNextMode = true;
  await selectEditorRange(0, 0, 1, 0);
  await waitFor(() => expect(scenario.deferredModeReleases).toHaveLength(1));
  fireEvent.keyDown(editor, { key: "Q" });
  await waitFor(() => expect(scenario.files.get("メモ/a.md")!.text).toBe("Q12"));
  await waitFor(() => expect(screen.getByTestId("cursor")).toHaveTextContent("カーソル 1:2"));
  scenario.deferredModeReleases.shift()!();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.getByTestId("cursor")).toHaveTextContent("カーソル 1:2");
  fireEvent.keyDown(editor, { key: "Z" });
  await waitFor(() => expect(scenario.files.get("メモ/a.md")!.text).toBe("QZ12"));
  const edits = mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits");
  expect(edits).toHaveLength(2);
  expect(edits[1][1]).toEqual(expect.objectContaining({ edits: [{ range: { start: 1, end: 1 }, text: "Z" }] }));
});

it("never lets a late older selection response reset a newer range", async () => {
  const text = "abcdefghij";
  scenario.files.set("メモ/a.md", { id: "doc_a", path: "メモ/a.md", text, revision: 0, dirty: false, history: [text] });
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await screen.findByTestId("editor-primary");
  fireEvent.change(screen.getByLabelText("表示モード"), { target: { value: "source" } });
  fireEvent.click(screen.getByRole("button", { name: "その他の操作" }));
  fireEvent.click(screen.getByRole("button", { name: "表示行" }));
  scenario.deferCursor = true;
  scenario.cursorResponses = [
    { anchor: 0, head: 2 },
    { anchor: 0, head: 5 },
  ];
  await selectEditorRange(0, 0, 0, 2);
  await waitFor(() => expect(scenario.deferredCursorReleases.length).toBeGreaterThan(0));
  await selectEditorRange(0, 0, 0, 5);
  await waitFor(() => expect(scenario.deferredCursorReleases).toHaveLength(2));
  // Newer response first, older response late: the newer range must stand.
  scenario.deferredCursorReleases[1]();
  await waitFor(() => expect(screen.getByTestId("cursor")).toHaveTextContent("カーソル 1:6"));
  scenario.deferredCursorReleases[0]();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.getByTestId("cursor")).toHaveTextContent("カーソル 1:6");
  scenario.deferCursor = false;
});

it("retries a stale text range once without duplicating", async () => {
  await openInsertDoc();
  scenario.mappingResult = false;
  // Transient revision bump between capture and apply: the first apply goes
  // stale, the single correspondence-checked retry lands exactly once.
  scenario.applyStaleOnce = true;
  const editor = screen.getByTestId("editor-primary");
  fireEvent.keyDown(editor, { key: "v", ctrlKey: true });
  pasteEvent(editor, "再送");
  await waitFor(() =>
    expect(mockedInvoke).toHaveBeenCalledWith(
      "apply_gui_edits",
      expect.objectContaining({
        documentId: "doc_a",
        edits: [{ range: { start: 0, end: 0 }, text: "再送" }],
      }),
    ),
  );
  const applies = mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits");
  expect(applies).toHaveLength(2);
  expect(scenario.files.get("メモ/a.md")!.text.startsWith("再送")).toBe(true);
  const occurrences = scenario.files.get("メモ/a.md")!.text.split("再送").length - 1;
  expect(occurrences).toBe(1);
});

it("writes nothing when a concurrent edit shifts the text under a collapsed caret", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await vi.waitFor(() => expect(screen.getByTestId("editor-primary")).toHaveTextContent("# A"));
  scenario.mode = "insert";
  fireEvent.click(screen.getByRole("button", { name: "メモ/b.md" }));
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await waitFor(() => expect(screen.getByTestId("vim-footer-mode")).toHaveTextContent("挿入"));
  scenario.mappingResult = false;
  // Concurrent external edit shifts every offset before the paste lands.
  const doc = scenario.files.get("メモ/a.md")!;
  doc.text = "外部\n" + doc.text;
  doc.revision += 1;
  const editor = screen.getByTestId("editor-primary");
  fireEvent.keyDown(editor, { key: "v", ctrlKey: true });
  pasteEvent(editor, "Q");
  await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(0);
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "nvim_input")).toHaveLength(0);
  expect(scenario.files.get("メモ/a.md")!.text.startsWith("外部\n# A")).toBe(true);
});

it("retries once when only the revision moved but the source is identical", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await vi.waitFor(() => expect(screen.getByTestId("editor-primary")).toHaveTextContent("# A"));
  scenario.mode = "insert";
  fireEvent.click(screen.getByRole("button", { name: "メモ/b.md" }));
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await waitFor(() => expect(screen.getByTestId("vim-footer-mode")).toHaveTextContent("挿入"));
  scenario.mappingResult = false;
  // Revision-only bump (checkpoint): the source still proves correspondence.
  scenario.files.get("メモ/a.md")!.revision += 1;
  const editor = screen.getByTestId("editor-primary");
  fireEvent.keyDown(editor, { key: "v", ctrlKey: true });
  pasteEvent(editor, "Q");
  await waitFor(() =>
    expect(mockedInvoke).toHaveBeenCalledWith(
      "apply_gui_edits",
      expect.objectContaining({ edits: [{ range: { start: 0, end: 0 }, text: "Q" }] }),
    ),
  );
  expect(scenario.files.get("メモ/a.md")!.text.startsWith("Q")).toBe(true);
});

it("surfaces a stale image range once without a duplicate file write", async () => {
  await openInsertDoc();
  scenario.pasteImageStaleOnce = true;
  const editor = screen.getByTestId("editor-primary");
  const file = {
    name: "stale.png",
    type: "image/png",
    size: 4,
    /** PNG bytes for stale-range single-write tests. */
    arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
  } as unknown as File;
  fireEvent.keyDown(editor, { key: "v", ctrlKey: true });
  pasteEvent(editor, "", [file]);
  await waitFor(() =>
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "paste_image")).toHaveLength(1),
  );
  expect(scenario.pastedImages).toHaveLength(0);
  expect(await screen.findByRole("alert")).toBeVisible();
});

it("keeps normal-mode Ctrl+V as native visual-block without a mapping query", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await vi.waitFor(() => expect(screen.getByTestId("editor-primary")).toHaveTextContent("# A"));
  const editor = screen.getByTestId("editor-primary");
  fireEvent.keyDown(editor, { key: "v", ctrlKey: true });
  await waitFor(() =>
    expect(mockedInvoke).toHaveBeenCalledWith("nvim_input_with_copy", { documentId: "doc_a", baseRevision: 0, keys: "<C-v>" }),
  );
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "has_nvim_mapping")).toHaveLength(0);
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(0);
});

it("feeds an immediate key natively when Visual installed before the mode refresh", async () => {
  await openInsertDoc();
  // Rust installed Visual via a selection report, but the shell refresh has
  // not landed yet: the footer still shows a stale Insert.
  scenario.mode = "visual";
  const editor = screen.getByTestId("editor-primary");
  fireEvent.keyDown(editor, { key: "x" });
  await waitFor(() =>
    expect(mockedInvoke).toHaveBeenCalledWith("nvim_input_with_copy", { documentId: "doc_a", baseRevision: 0, keys: "x" }),
  );
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(0);
  expect(scenario.files.get("メモ/a.md")!.text).toBe("# A\n\n- [ ] task\n");
});

it.each([false, true])("binds read image hydration to the document and never reuses another doc bytes (delayed open: %s)", async (delayedOpen) => {
  /** Release a parked native open, then observe this document's active editor. */
  async function activateDocument(path: string) {
    const previousLabel = screen.queryByTestId("editor-primary")?.getAttribute("aria-label");
    const previousSrc = screen.queryByTestId("preview")?.querySelector("img")?.getAttribute("src");
    scenario.deferNextOpen = delayedOpen;
    fireEvent.click(screen.getByRole("button", { name: path }));
    if (delayedOpen) {
      await waitFor(() => expect(scenario.deferredOpenReleases).toHaveLength(1));
      expect(screen.queryByTestId("editor-primary")?.getAttribute("aria-label")).toBe(previousLabel);
      expect(screen.queryByTestId("preview")?.querySelector("img")?.getAttribute("src")).toBe(previousSrc);
      act(() => scenario.deferredOpenReleases.shift()!());
    }
    await waitFor(() => expect(screen.getByTestId("editor-primary")).toHaveAttribute("aria-label", `${path}のMarkdownエディタ`));
  }

  const identical = "![alt](img.png)\n";
  scenario.files.set("メモ/a.md", { id: "doc_a", path: "メモ/a.md", text: identical, revision: 0, dirty: false, history: [identical] });
  scenario.files.set("メモ/b.md", { id: "doc_b", path: "メモ/b.md", text: identical, revision: 0, dirty: false, history: [identical] });
  scenario.imageBytes.set("doc_a:img.png", { mime: "image/png", bytes: [1, 2, 3, 4] });
  scenario.imageBytes.set("doc_b:img.png", { mime: "image/png", bytes: [9, 8, 7, 6, 5] });
  await openWorkspace();
  await activateDocument("メモ/a.md");
  expect(screen.getByLabelText("表示モード")).toBeEnabled();
  fireEvent.change(screen.getByLabelText("表示モード"), { target: { value: "read" } });
  await waitFor(() => expect(screen.getByTestId("preview").querySelector("img")).not.toBeNull());
  await waitFor(() =>
    expect(mockedInvoke).toHaveBeenCalledWith("load_relative_image", { documentId: "doc_a", path: "img.png" }),
  );
  await waitFor(() => {
    const src = screen.getByTestId("preview").querySelector("img")?.getAttribute("src") ?? "";
    expect(src.startsWith("data:image/png;base64,")).toBe(true);
  });
  const srcA = screen.getByTestId("preview").querySelector("img")?.getAttribute("src") ?? "";
  // Identical Markdown and filename in doc B must resolve B's own bytes.
  // Observe B's activation and rendered image before waiting for hydration:
  // identical content cannot distinguish A's old preview from B's new one.
  await activateDocument("メモ/b.md");
  expect(screen.getByLabelText("表示モード")).toHaveValue("read");
  await waitFor(() => expect(screen.getByTestId("preview").querySelector("img")).not.toBeNull());
  await waitFor(() =>
    expect(mockedInvoke).toHaveBeenCalledWith("load_relative_image", { documentId: "doc_b", path: "img.png" }),
  );
  await waitFor(() => {
    const src = screen.getByTestId("preview").querySelector("img")?.getAttribute("src") ?? "";
    expect(src.startsWith("data:image/png;base64,")).toBe(true);
    expect(src).not.toBe(srcA);
  });
  const srcB = screen.getByTestId("preview").querySelector("img")?.getAttribute("src") ?? "";
  expect(srcB).not.toBe(srcA);
  // Switching back restores A's bytes, not a stale reuse of B.
  await activateDocument("メモ/a.md");
  await waitFor(() => {
    expect(screen.getByTestId("preview").querySelector("img")?.getAttribute("src")).toBe(srcA);
  });
});

it("routes display-basis arrows natively in Visual so x-mode mappings fire", async () => {  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await vi.waitFor(() => expect(screen.getByTestId("editor-primary")).toHaveTextContent("# A"));
  // Native Visual install (740d5d5): refresh the shell mode snapshot.
  scenario.mode = "visual";
  fireEvent.click(screen.getByRole("button", { name: "メモ/b.md" }));
  fireEvent.click(screen.getByRole("button", { name: "メモ/a.md" }));
  await waitFor(() => expect(screen.getByTestId("vim-footer-mode")).toHaveTextContent("選択"));
  const editor = screen.getByTestId("editor-primary");
  fireEvent.keyDown(editor, { key: "ArrowUp" });
  await waitFor(() =>
    expect(mockedInvoke).toHaveBeenCalledWith("nvim_input_with_copy", { documentId: "doc_a", baseRevision: 0, keys: "<Up>" }),
  );
});




it("keeps text typed immediately after Enter on the native queue until cursor refresh completes", async () => {
  await openInsertDoc();
  const editor = screen.getByTestId("editor-primary");
  fireEvent.keyDown(editor, { key: "Enter" });
  fireEvent.keyDown(editor, { key: "x" });
  await waitFor(() => {
    const inputs = mockedInvoke.mock.calls.filter(([command]) => command === "nvim_input_with_copy");
    expect(inputs.map(([, args]) => (args as { keys: string }).keys)).toEqual(["<CR>", "x"]);
  });
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(0);
});

it("keeps native insert mappings for printable CodeMirror keyboard input", async () => {
  await openInsertDoc();
  scenario.mappingResult = true;
  const view = EditorView.findFromDOM(screen.getByTestId("editor-primary").querySelector(".cm-editor") as HTMLElement)!;
  fireEvent.keyDown(view.contentDOM, { key: "j" });
  act(() => view.dispatch({ changes: { from: 0, insert: "j" }, selection: { anchor: 1 } }));
  fireEvent.keyUp(view.contentDOM, { key: "j" });
  await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("nvim_input", expect.objectContaining({ documentId: "doc_a", keys: "j" })));
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(0);
  expect(mockedInvoke).toHaveBeenCalledWith("has_nvim_mapping", { documentId: "doc_a", mode: "i", lhs: "j" });
});

it("keeps Unicode committed immediately after Enter on the native cursor queue", async () => {
  await openInsertDoc();
  const view = EditorView.findFromDOM(screen.getByTestId("editor-primary").querySelector(".cm-editor") as HTMLElement)!;
  fireEvent.keyDown(view.contentDOM, { key: "Enter" });
  act(() => view.dispatch({ changes: { from: 0, insert: "日本語" }, selection: { anchor: 3 } }));
  await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("nvim_input", { documentId: "doc_a", baseRevision: 1, keys: "日本語" }));
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(0);
});

it("retains the native cursor for composition started before Enter acknowledgement", async () => {
  await openInsertDoc();
  const view = EditorView.findFromDOM(screen.getByTestId("editor-primary").querySelector(".cm-editor") as HTMLElement)!;
  fireEvent.keyDown(view.contentDOM, { key: "Enter" });
  fireEvent.compositionStart(view.contentDOM);
  act(() => view.dispatch({ changes: { from: 0, insert: "日本語" }, selection: { anchor: 3 } }));
  await waitFor(() => expect(screen.getByTestId("revision")).toHaveTextContent("リビジョン 1"));
  await new Promise(resolve => setTimeout(resolve, 0));
  fireEvent.compositionEnd(view.contentDOM);
  await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("nvim_input", { documentId: "doc_a", baseRevision: 1, keys: "日本語" }));
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(0);
});
