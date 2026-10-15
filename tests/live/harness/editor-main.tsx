// Browser-only production-shell fixture. Native transport is deliberately simulated;
// real Neovim and physical OS IME acceptance remain separate.
import { useMemo, useState } from "react";
import { EditorView } from "@codemirror/view";
import { createRoot } from "react-dom/client";
import { WorkspaceShell } from "../../../src/presentation/shell/WorkspaceShell";
import { RegistryClient } from "../../../src/application/document/registry-client";
import { workspaceApi } from "../../../src/infrastructure/tauri/workspace-api";
import { loadEditorPreferences, saveEditorPreferences } from "../../../src/infrastructure/storage/editor-preferences-store";
import { applyTextEdits, lineRangeAt } from "../../../src/domain/coordinates/utf16";
import type { CursorUpdate, DocumentSnapshot, EditorContext, SaveRequest, TextEdit, VimMode, WorkspaceEntry } from "../../../src/contracts/contracts";
import "../../../src/styles.css";

interface Options { text?: string; path?: string; mode?: VimMode; popup?: boolean; readonly?: boolean; workbench?: boolean }
let treeEntries: WorkspaceEntry[] = [];
let options: Options = {};
let text = "日本😀の文章";
let path = "note.md";
let revision = 0;
let mode: VimMode = "insert";
let cursor: CursorUpdate = { documentId: "fixture", revision: 0, anchor: 0, head: 0 };
let history = [text];
let undoIndex = 0;
let clipboard = "貼付😀";
const calls: string[] = [];

/** Return a copy of the simulated authoritative snapshot. */
function snapshot(): DocumentSnapshot { return { documentId: "fixture", revision, text, dirty: revision > 0 }; }
/** Reset explicit browser-fixture state for one focused interaction scenario. */
function reset(next: Options) {
  options = next; text = next.text ?? "日本😀の文章"; path = next.path ?? "note.md"; mode = next.mode ?? "insert"; revision = 0;
  cursor = { documentId: "fixture", revision, anchor: text.length, head: text.length };
  history = [text]; undoIndex = 0; calls.length = 0; clipboard = "貼付😀";
  treeEntries = [{ path, name: path, directory: false, markdown: path.endsWith(".md"), kind: path.endsWith(".md") ? "markdown" : "text" }];
  if (next.workbench) treeEntries.push(
    { path: "notes", name: "notes", directory: true, markdown: false },
    { path: "notes/guide.md", name: "guide.md", directory: false, markdown: true, kind: "markdown" },
    { path: "assets", name: "assets", directory: true, markdown: false },
    { path: "assets/photo.png", name: "photo.png", directory: false, markdown: false, kind: "image" },
    { path: "settings.json", name: "settings.json", directory: false, markdown: false, kind: "text" },
  );
}
/** Refuse stale simulated transport requests rather than overwriting captured input. */
function check(request: SaveRequest) { if (request.baseRevision !== revision) throw { code: "contract", error: { code: "stale_revision", expected: revision, received: request.baseRevision } }; }
/** Commit a browser-fixture range change with simulated native history. */
function commit(edits: TextEdit[]) {
  if (options.readonly) throw new Error("fixture read-only");
  text = applyTextEdits(text, edits); revision += 1;
  history = history.slice(0, undoIndex + 1); history.push(text); undoIndex += 1;
  return snapshot();
}
/** Simulate native history without synthesizing browser undo events. */
function historyStep(redo: boolean) {
  undoIndex = Math.max(0, Math.min(history.length - 1, undoIndex + (redo ? 1 : -1))); text = history[undoIndex]; revision += 1;
  cursor.anchor = cursor.head = Math.min(cursor.head, text.length); return snapshot();
}
/** Simulate the small key surface needed to verify shell routing and visible controls. */
function input(request: SaveRequest, keys: string) {
  check(request); calls.push(`input:${keys}@${revision}`);
  if (keys === "<Esc>") mode = "normal";
  else if (["i", "a", "A"].includes(keys) && mode === "normal") { mode = "insert"; if (keys === "A") cursor.anchor = cursor.head = lineRangeAt(text, cursor.head).end; }
  else if (mode === "insert" && keys === "<CR>") {
    commit([{ range: { start: cursor.head, end: cursor.head }, text: "\n" }]); cursor.anchor = cursor.head = cursor.head + 1;
  }
  else if (mode === "insert" && keys.length === 1) { commit([{ range: { start: cursor.head, end: cursor.head }, text: keys }]); cursor.anchor = cursor.head = cursor.head + keys.length; }
  return snapshot();
}
const backend = {
  ...workspaceApi,
  /** Supply fixture workspace entries. */
  listWorkspace: async (parent = "") => treeEntries.filter((entry) => entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) === parent : parent === ""),
  /** Simulate the already-existing native folder command without opening or changing a document. */
  createFolder: async (relative: string) => {
    if (treeEntries.some((entry) => entry.path === relative)) throw { code: "already_exists" };
    const entry: WorkspaceEntry = { path: relative, name: relative.split("/").at(-1)!, directory: true, markdown: false };
    treeEntries.push(entry); calls.push(`create_folder:${relative}`); return entry;
  },
  /** Open only this fixture workspace. */
  openWorkspace: async () => ({ root: "fixture", scope: { rootId: "fixture-root", generation: "1" } }),
  /** Return the current fixture document descriptor. */
  listDocuments: async () => [{ path, snapshot: snapshot() }],
  /** Return the same contained fixture document. */
  openMarkdown: async () => ({ path, snapshot: snapshot() }),
  /** Return the same plain-text fixture descriptor. */
  openTextFile: async () => ({ path, snapshot: snapshot() }),
  /** Read fixture state after a stale rejection. */
  fetchSnapshot: async () => snapshot(),
  /** Preserve revision and optional native selection guards for formatting. */
  applyEdits: async (request: SaveRequest, edits: TextEdit[], expected?: CursorUpdate) => { check(request); if (expected && (expected.anchor !== cursor.anchor || expected.head !== cursor.head)) throw new Error("fixture selection changed"); calls.push(`edit@${revision}`); return commit(edits); },
  /** Read the actual fixture mode. */
  fetchMode: async () => ({ documentId: "fixture", revision, mode }),
  /** Preserve native key notation before simulated routing. */
  input: async (request: SaveRequest, keys: string) => input(request, keys),
  /** Return the same simulated native input plus empty copy side effects. */
  inputWithCopy: async (request: SaveRequest, keys: string) => ({ snapshot: input(request, keys), copyReady: false, copy: null }),
  /** Leave tested Enter/Tab unmapped in this browser-only fixture. */
  hasMapping: async () => false,
  /** Read the current fixture cursor at its exact revision. */
  fetchCursor: async () => ({ ...cursor, revision }),
  /** Install cursor reports and expose Visual selection outside Insert mode. */
  reportCursor: async (next: CursorUpdate) => { if (next.revision !== revision) throw new Error("fixture stale cursor"); cursor = next; if (mode !== "insert") mode = next.anchor === next.head ? "normal" : "visual"; calls.push(`cursor:${next.head}@${revision}`); return next; },
  /** Return runtime menu data from the explicit fixture state. */
  fetchEditorContext: async (request: SaveRequest): Promise<EditorContext> => { check(request); return { cursor: { ...cursor, revision }, mode, presentation: { editable: !options.readonly, selectionToolbar: options.popup ?? false, mappings: [{ lhs: "Q", rhs: ":echo 'actual fixture mapping'<CR>" }] } }; },
  /** Run a cursor-guarded simulated clipboard action. */
  editorClipboard: async (expected: CursorUpdate, action: "copy" | "cut" | "paste") => {
    check({ documentId: expected.documentId, baseRevision: expected.revision });
    if (expected.anchor !== cursor.anchor || expected.head !== cursor.head) throw new Error("fixture selection changed");
    const start = Math.min(cursor.anchor, cursor.head), end = Math.max(cursor.anchor, cursor.head);
    calls.push(`clipboard:${action}@${revision}`);
    if (action !== "paste") clipboard = text.slice(start, end);
    if (action === "copy") return snapshot();
    const result = commit([{ range: { start, end }, text: action === "paste" ? clipboard : "" }]);
    cursor.anchor = cursor.head = start + (action === "paste" ? clipboard.length : 0); mode = "normal"; return result;
  },
  /** Traverse the fixture's history through the same guarded menu port. */
  editorHistory: async (request: SaveRequest, redo: boolean) => { check(request); return historyStep(redo); },
  /** Route the persistent toolbar undo to the same simulated native history. */
  undo: async () => historyStep(false),
  /** Route the persistent toolbar redo to the same simulated native history. */
  redo: async () => historyStep(true),
  /** Keep optional workspace recovery empty. */
  listRecovery: async () => [],
  /** Keep the fixture event source quiet. */
  pollEvents: async () => [],
  /** Supply a harmless active configuration descriptor. */
  fetchConfig: async () => ({ path: null, errors: [], copyKeys: {} }),
};

interface FixtureApi {
  /** Replace fixture input and remount its shell. */
  load(options: Options): void;
  /** Read fixture source text. */
  getText(): string;
  /** Read exact transport execution calls. */
  getCalls(): string[];
  /** Stage a source selection through the actual editor view for focused cell/menu tests. */
  select(anchor: number, head: number, nextMode?: VimMode): void;
}
declare global { interface Window { __editorFixture: FixtureApi } }

/** Host the production shell with an explicitly simulated transport and real preference persistence. */
function Harness() {
  const [generation, setGeneration] = useState(0);
  const client = useMemo(() => { const registry = new RegistryClient(backend); registry.noteSnapshot(snapshot()); return registry; }, [generation]);
  window.__editorFixture = {
    /** Reset one fixture scenario. */
    load: (next) => { reset(next); setGeneration((old) => old + 1); },
    /** Read exact current fixture source. */
    getText: () => text,
    /** Read serial execution order. */
    getCalls: () => [...calls],
    /** Dispatch a source selection through the production CodeMirror callbacks. */
    select: (anchor, head, nextMode) => {
      if (nextMode) mode = nextMode;
      const content = document.querySelector<HTMLElement>(".cm-content");
      if (!content) throw new Error("fixture editor not mounted");
      const view = EditorView.findFromDOM(content);
      view?.dispatch({ selection: { anchor, head } }); view?.focus();
    },
  };
  return <WorkspaceShell key={generation} desktop documentGateway={client} workspaceGateway={backend} eventSource={{
    /** Keep pushed native events silent in the explicit fixture. */
    listen: async () => () => {},
  }} runtimeGateway={{
    /** Report this explicitly simulated browser runtime as available to the shell. */
    readStatus: async () => ({ contractVersion: 1, connection: "connected", detail: "Browser fixture, not native WebView proof" }),
  }} dialogGateway={{
    /** Return the contained fixture root without opening a host dialog. */
    pickFolder: async () => "fixture",
    /** Leave config-file selection unexercised. */
    pickConfigFile: async () => null,
  }} editorPreferencesStore={{ load: loadEditorPreferences, save: saveEditorPreferences }} />;
}
reset({});
createRoot(document.getElementById("root")!).render(<Harness />);
