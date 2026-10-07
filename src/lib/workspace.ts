// Workspace provider for Issue #5.
//
// Issue #4 (Codex) owns the Rust backend: folder tree, full-text
// search/replace, relative images, atomic save, external changes, conflict
// resolution, crash recovery. Until those Tauri commands land, the UI runs
// on this in-memory provider with the same Japanese labels and revision
// semantics so #4 can replace the provider without rewriting the shell.

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

export const SAMPLE_WORKSPACE: WorkspaceFile[] = [
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

// Issue #4 preview (Codex): the workspace registry will extend the same Tauri
// command registry; Issue #5 implements no Rust IPC and calls none of these
// until they land. Names recorded here so the TS adapter shape stays stable:
// open_workspace(path), list_workspace(path), open_markdown(path),
// create_markdown(path,text), rename_markdown(documentId,path,baseRevision),
// search_workspace(query), close_document(documentId,baseRevision,action),
// poll_workspace_events, list_recovery, restore_recovery(documentId),
// load_relative_image(documentId,path),
// paste_image(documentId,baseRevision,name,bytes,range).
// Document commands keep documentId + baseRevision and reuse Utf16Range.
export type WorkspacePreviewCommand =
  | "open_workspace"
  | "list_workspace"
  | "open_markdown"
  | "create_markdown"
  | "rename_markdown"
  | "search_workspace"
  | "close_document"
  | "poll_workspace_events"
  | "list_recovery"
  | "restore_recovery"
  | "load_relative_image"
  | "paste_image";

export const SUPPORTED_CONFIG_NAMES = ["vimrc", "_vimrc", "init.vim", "init.lua"] as const;

export function isSupportedConfigName(name: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? name;
  return (SUPPORTED_CONFIG_NAMES as readonly string[]).includes(base);
}
