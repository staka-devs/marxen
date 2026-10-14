// Deterministic workspace content helpers (domain).
//
// Pure file search, outline, replace, theme, and demo content. No Tauri,
// DOM, React, or browser globals: the real Neovim buffer stays authoritative
// and these helpers only shape in-memory text and paths.

import githubMarkdownFixture from "../../tests/fixtures/github-markdown.md?raw";

/** In-memory file used for literal search and demo rendering. */
export interface WorkspaceFile {
  path: string;
  text: string;
}

/** Markdown heading with its global UTF-16 offset and 0-based line. */
export interface OutlineItem {
  level: number;
  title: string;
  /** Global UTF-16 offset of the heading start. */
  offset: number;
  line: number;
}

/** Available editor chrome themes. */
export type ThemeId = "light" | "dark" | "contrast";

/** Labeled theme options shown in the settings panel. */
export const THEMES: { id: ThemeId; label: string }[] = [
  { id: "light", label: "ライト" },
  { id: "dark", label: "ダーク" },
  { id: "contrast", label: "ハイコントラスト" },
];

/**
 * Check whether the query characters appear in order inside the target.
 *
 * Case-insensitive subsequence match for quick-open and the command palette;
 * an empty query matches everything so clearing the input restores the list.
 */
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

/**
 * Keep only paths matching the query, preserving the input order.
 *
 * Thin filter over {@link fuzzyMatch} for quick-open lists.
 */
export function filterPaths(paths: string[], query: string): string[] {
  return paths.filter((path) => fuzzyMatch(query, path));
}

/**
 * Extract `#`..`######` headings with global offsets, skipping fenced code.
 *
 * Offsets count UTF-16 units so outline jumps land on the registry contract.
 */
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

/** Single literal search hit inside one in-memory file. */
export interface SearchHit {
  path: string;
  line: number;
  col: number;
  preview: string;
  offset: number;
  end: number;
  previewRange: { start: number; end: number };
}

/**
 * Find literal (non-regex) occurrences of the query across open files.
 *
 * Scans line by line up to `maxHits`; empty queries return nothing so the
 * search panel stays empty until the user types.
 */
export function searchWorkspace(files: WorkspaceFile[], query: string, maxHits = 100): SearchHit[] {
  if (query === "") return [];
  const hits: SearchHit[] = [];
  for (const file of files) {
    const lines = file.text.split("\n");
    let offset = 0;
    for (let line = 0; line < lines.length && hits.length < maxHits; line += 1) {
      let from = 0;
      for (;;) {
        const col = lines[line].indexOf(query, from);
        if (col < 0) break;
        const start = col - Array.from(lines[line].slice(0, col)).slice(-80).join("").length;
        const preview = Array.from(lines[line].slice(start)).slice(0, 240).join("");
        hits.push({ path: file.path, line, col, preview, offset: offset + col, end: offset + col + query.length,
          previewRange: { start: col - start, end: Math.min(preview.length, col - start + query.length) } });
        from = col + Math.max(1, query.length);
        if (hits.length >= maxHits) break;
      }
      offset += lines[line].length + 1;
    }
  }
  return hits;
}

/** Single ascending wire range edit used for revision-aware replace. */
export interface ReplaceEdit {
  range: { start: number; end: number };
  text: string;
}

/**
 * Express literal replace as ascending wire range edits against the base text.
 *
 * Callers send the result with the snapshot revision the text was read at;
 * stale bases resync instead of retrying blindly.
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

/**
 * Browser-demo-only sample workspace, never authoritative.
 *
 * The desktop reads every document through the registry; the demo stays
 * read-only and mirrors short excerpts of `tests/fixtures/` for layout checks.
 */
export const SAMPLE_WORKSPACE: WorkspaceFile[] = [
  {
    path: "メモ/はじめに.md",
    text: "# はじめに\n\nMarxen へようこそ。Markdownと Vim 操作を大切にします。\n\n- [ ] 日本語で書く\n- [ ] プレビューを見る\n\n| 項目 | 状態 |\n| --- | --- |\n| Markdown | 保持 |\n",
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
  {
    path: "検証/不正な構文.md",
    text: "# 不正な構文でも表示を続けられるサンプル\n\n```mermaid\nflowchart LR\n    A --> [\n```\n\n$$\n\\frac{1}{\n$$\n\n最後の段落はMarkdownのまま残ること。\n",
  },
  {
    path: "検証/安全でないHTML.md",
    text: "# HTMLのサニタイズ検証\n\n<script>window.__marxenUnsafe = true</script>\n\n[無効なリンク](javascript:window.__marxenUnsafe=true)\n\nこの本文は表示できる。\n",
  },
];

/** Neovim config filenames the shell accepts for `configure_document`. */
export const SUPPORTED_CONFIG_NAMES = ["vimrc", "_vimrc", ".vimrc", "init.vim", "init.lua"] as const;

/**
 * Check whether the basename matches a supported Neovim config filename.
 *
 * Accepts absolute or workspace-relative paths by comparing only the final
 * segment, so picker and manual inputs share one rule.
 */
export function isSupportedConfigName(name: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? name;
  return (SUPPORTED_CONFIG_NAMES as readonly string[]).includes(base);
}
