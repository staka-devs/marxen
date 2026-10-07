import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  CloseAction, CursorUpdate, DocumentId, DocumentSnapshot, GridUpdate, ImageData,
  ModeUpdate, NvimConfig, OpenDocument, PasteResult, RecoveryEntry, SaveRequest,
  SaveResult, SearchMatch, TextEdit, Utf16Range, WorkspaceEntry, WorkspaceEvent,
  WorkspaceInfo,
} from "../shared/contracts";

/** Native commands never read/write files in JS; ranges count UTF-16 units. */
export const workspaceApi = {
  openWorkspace: (path: string) => invoke<WorkspaceInfo>("open_workspace", { path }),
  listWorkspace: (path = "") => invoke<WorkspaceEntry[]>("list_workspace", { path }),
  listDocuments: () => invoke<OpenDocument[]>("list_documents"),
  openMarkdown: (path: string) => invoke<OpenDocument>("open_markdown", { path }),
  createMarkdown: (path: string, text = "") => invoke<OpenDocument>("create_markdown", { path, text }),
  renameMarkdown: (request: SaveRequest, path: string) => invoke<OpenDocument>("rename_markdown", { ...request, path }),
  fetchSnapshot: (documentId: DocumentId) => invoke<DocumentSnapshot>("fetch_snapshot", { documentId }),
  applyEdits: (request: SaveRequest, edits: TextEdit[]) => invoke<DocumentSnapshot>("apply_gui_edits", { ...request, edits }),
  saveDocument: (request: SaveRequest) => invoke<SaveResult>("save_document", { ...request }),
  reloadDocument: (request: SaveRequest) => invoke<DocumentSnapshot>("reload_document", { ...request }),
  closeDocument: (request: SaveRequest, action: CloseAction) => invoke<boolean>("close_document", { ...request, action }),
  searchWorkspace: (query: string) => invoke<SearchMatch[]>("search_workspace", { query }),
  pollEvents: () => invoke<WorkspaceEvent[]>("poll_workspace_events"),
  listRecovery: () => invoke<RecoveryEntry[]>("list_recovery"),
  restoreRecovery: (documentId: DocumentId) => invoke<OpenDocument>("restore_recovery", { documentId }),
  discardRecovery: (documentId: DocumentId) => invoke<void>("discard_recovery", { documentId }),
  loadImage: (documentId: DocumentId, path: string) => invoke<ImageData>("load_relative_image", { documentId, path }),
  pasteImage: (request: SaveRequest, name: string, bytes: Uint8Array, range: Utf16Range) =>
    invoke<PasteResult>("paste_image", { ...request, name, bytes: Array.from(bytes), range }),
  input: (request: SaveRequest, keys: string) => invoke<DocumentSnapshot>("nvim_input", { ...request, keys }),
  fetchMode: (documentId: DocumentId) => invoke<ModeUpdate>("fetch_mode", { documentId }),
  fetchCursor: (documentId: DocumentId) => invoke<CursorUpdate>("fetch_cursor", { documentId }),
  reportCursor: (update: CursorUpdate) => invoke<CursorUpdate>("report_cursor", { ...update }),
  fetchGrid: (documentId: DocumentId, width = 80, height = 24) => invoke<GridUpdate>("fetch_grid", { documentId, width, height }),
  undo: (documentId: DocumentId) => invoke<DocumentSnapshot>("undo_document", { documentId }),
  redo: (documentId: DocumentId) => invoke<DocumentSnapshot>("redo_document", { documentId }),
  configure: (request: SaveRequest, path: string | null) => invoke<NvimConfig>("configure_document", { ...request, path }),
  fetchConfig: (documentId: DocumentId) => invoke<NvimConfig>("fetch_config", { documentId }),
};

/** Events also remain available via pollEvents for reconnecting consumers. */
export function listenWorkspaceEvents(callback: (events: WorkspaceEvent[]) => void): Promise<UnlistenFn> {
  if (!isTauri()) return Promise.resolve(() => {});
  return listen<WorkspaceEvent[]>("marxen:workspace", (event) => callback(event.payload));
}

import githubMarkdownFixture from "../../tests/fixtures/github-markdown.md?raw";
export function isDesktop(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

export interface WorkspaceFile {
  path: string;
  text: string;
}

export interface OutlineItem {
  level: number;
  title: string;
  /** Global UTF-16 offset of the heading start. */
  offset: number;
  line: number;
}

export type ThemeId = "light" | "dark" | "contrast";

export const THEMES: { id: ThemeId; label: string }[] = [
  { id: "light", label: "ライト" },
  { id: "dark", label: "ダーク" },
  { id: "contrast", label: "ハイコントラスト" },
];

/** Case-insensitive subsequence match for quick-open and palette. */
export function fuzzyMatch(query: string, target: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const t = target.toLowerCase();
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i += 1) {
    if (t[i] === q[qi]) qi += 1;
  }
  return qi === q.length;
}

export function filterPaths(paths: string[], query: string): string[] {
  return paths.filter((path) => fuzzyMatch(query, path));
}

/** Headings (`#`..`######`) with global offsets. Code fences are skipped. */
export function outlineFromMarkdown(text: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  const lines = text.split("\n");
  let offset = 0;
  let fenced = false;
  for (let line = 0; line < lines.length; line += 1) {
    const raw = lines[line];
    if (/^\s*```/.test(raw)) fenced = !fenced;
    if (!fenced) {
      const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
      if (match) {
        out.push({ level: match[1].length, title: match[2], offset, line });
      }
    }
    offset += raw.length + 1;
  }
  return out;
}

export interface SearchHit {
  path: string;
  line: number;
  col: number;
  preview: string;
}

/** Literal (non-regex) full-text search across open files. */
export function searchWorkspace(files: WorkspaceFile[], query: string, maxHits = 100): SearchHit[] {
  if (query === "") return [];
  const hits: SearchHit[] = [];
  for (const file of files) {
    const lines = file.text.split("\n");
    for (let line = 0; line < lines.length && hits.length < maxHits; line += 1) {
      let from = 0;
      for (;;) {
        const col = lines[line].indexOf(query, from);
        if (col < 0) break;
        hits.push({ path: file.path, line, col, preview: lines[line].trim().slice(0, 120) });
        from = col + Math.max(1, query.length);
        if (hits.length >= maxHits) break;
      }
    }
  }
  return hits;
}

/** Replace all literal occurrences; returns the new text and hit count. */
export function replaceAll(text: string, query: string, replacement: string): { text: string; count: number } {
  if (query === "") return { text, count: 0 };
  let count = 0;
  let from = 0;
  let out = "";
  for (;;) {
    const idx = text.indexOf(query, from);
    if (idx < 0) {
      out += text.slice(from);
      break;
    }
    count += 1;
    out += text.slice(from, idx) + replacement;
    from = idx + query.length;
  }
  return { text: out, count };
}

export interface ReplaceEdit {
  range: { start: number; end: number };
  text: string;
}

/**
 * Revision-aware replace expressed as ascending wire range edits against the
 * given base text. Callers send the result with the snapshot revision the
 * text was read at; stale bases resync instead of retrying blindly.
 */
export function replaceEdits(text: string, query: string, replacement: string): { edits: ReplaceEdit[]; count: number } {
  if (query === "") return { edits: [], count: 0 };
  const edits: ReplaceEdit[] = [];
  let from = 0;
  for (;;) {
    const idx = text.indexOf(query, from);
    if (idx < 0) break;
    edits.push({ range: { start: idx, end: idx + query.length }, text: replacement });
    from = idx + query.length;
  }
  return { edits, count: edits.length };
}

export const SAMPLE_WORKSPACE: WorkspaceFile[] = [
  // Browser-demo-only sample content. Never authoritative: the desktop reads
  // every document through the Issue #4 registry, and the demo stays read-only.
  {
    path: "メモ/はじめに.md",
    text: "# はじめに\n\nMarxen へようこそ。原文と Vim 操作を大切にします。\n\n- [ ] 日本語で書く\n- [ ] プレビューを見る\n\n| 項目 | 状態 |\n| --- | --- |\n| 原文 | 保持 |\n",
  },
  {
    path: "メモ/東京.md",
    text: "# 東京 😀\n\n日本語と絵文字の表示確認。\n\n## 見出し\n\n本文の **太字** と `code`。\n",
  },
  {
    path: "README.md",
    text: "# Marxen\n\n書くことに、集中できる場所。\n",
  },
  {
    path: "検証/GitHub記法.md",
    text: githubMarkdownFixture,
  },
  // Invalid-input demo docs (short excerpts mirroring tests/fixtures/; the
  // full fixtures are asserted in unit tests). Browser renders them read-only.
  {
    path: "検証/不正な構文.md",
    text: "# 不正な構文でも表示を続けられるサンプル\n\n```mermaid\nflowchart LR\n    A --> [\n```\n\n$$\n\\frac{1}{\n$$\n\n最後の段落は原文のまま残ること。\n",
  },
  {
    path: "検証/安全でないHTML.md",
    text: "# HTMLのサニタイズ検証\n\n<script>window.__marxenUnsafe = true</script>\n\n[無効なリンク](javascript:window.__marxenUnsafe=true)\n\nこの本文は表示できる。\n",
  },
];

export const SUPPORTED_CONFIG_NAMES = ["vimrc", "_vimrc", "init.vim", "init.lua"] as const;

export function isSupportedConfigName(name: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? name;
  return (SUPPORTED_CONFIG_NAMES as readonly string[]).includes(base);
}
