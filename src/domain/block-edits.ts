// Notion-style block operations on Markdown source (domain).
//
// Blocks are top-level source ranges (`computeLiveBlocks`). Every operation
// returns plain range edits on the original text, so they travel the same
// revisioned GUI edit path as typing and Neovim stays the source of truth.

import type { TextEdit } from "../contracts/contracts";
import type { LabelKey } from "../contracts/localization";
import { parseFrontmatter, setPropertyEdit } from "./frontmatter";

/** A block's UTF-16 range in the source. */
export interface BlockRange {
  from: number;
  to: number;
}

/** One insertable block: its label key, search words, Markdown and caret offset in it. */
export interface BlockTemplate {
  id: string;
  /** Japanese catalog key shown through the translator. */
  label: LabelKey;
  icon: string;
  keywords: string;
  text: string;
  caret: number;
  /** Database views need `database: true` in the note's frontmatter. */
  database?: boolean;
}

/** Build a template whose caret sits at the `|` marker (or the end). */
function template(id: string, label: LabelKey, icon: string, keywords: string, marked: string, database = false): BlockTemplate {
  const caret = marked.indexOf("|");
  return { id, label, icon, keywords, text: marked.replace("|", ""), caret: caret < 0 ? marked.length : caret, database };
}

/** Blocks offered by the `/` menu and the block handle's `+`. */
export const BLOCK_TEMPLATES: readonly BlockTemplate[] = [
  template("text", "テキスト", "¶", "text paragraph p", ""),
  template("h1", "見出し1", "H1", "heading h1 #", "# "),
  template("h2", "見出し2", "H2", "heading h2 ##", "## "),
  template("h3", "見出し3", "H3", "heading h3 ###", "### "),
  template("bullet", "箇条書き", "•", "bullet list ul -", "- "),
  template("numbered", "番号付きリスト", "1.", "numbered ordered list ol", "1. "),
  template("todo", "ToDo リスト", "☐", "todo task checkbox", "- [ ] "),
  template("quote", "引用", "❝", "quote blockquote >", "> "),
  template("callout", "コールアウト", "💡", "callout note alert", "> [!NOTE]\n> "),
  template("toggle", "トグル", "▸", "toggle details summary", "<details>\n<summary>|</summary>\n\n</details>"),
  template("divider", "区切り線", "—", "divider hr rule", "***\n"),
  template("code", "コード", "</>", "code fence", "```\n|\n```"),
  template("math", "数式", "∑", "math equation latex", "$$\n|\n$$"),
  template("table", "表", "▦", "table grid", "| 列1 | 列2 |\n| --- | --- |\n| | |"),
  template("mermaid", "図（Mermaid）", "⧉", "mermaid diagram chart", "```mermaid\nflowchart TD\n  A[開始] --> B[終了]\n```"),
  template("database", "データベース（表）", "⊞", "database table db notion", "```database\nfolder: .\n```", true),
  template("board", "データベース（ボード）", "▥", "database board kanban notion", "```database\nfolder: .\nview: board\ngroup: status\n```", true),
];

/** Templates whose label (translated or not), id or keywords contain `query`. */
export function filterTemplates(query: string, label: (key: LabelKey) => string): BlockTemplate[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...BLOCK_TEMPLATES];
  return BLOCK_TEMPLATES.filter((item) => `${item.id} ${item.keywords} ${item.label} ${label(item.label)}`.toLowerCase().includes(needle));
}

/** Edit that turns on database views for the note, or null when already on. */
export function databaseFlagEdit(text: string): TextEdit | null {
  const front = parseFrontmatter(text);
  const flag = front?.properties.find((property) => property.key === "database");
  if (flag?.value.trim().toLowerCase() === "true") return null;
  if (flag) return setPropertyEdit(text, "database", "true");
  if (!front) return { range: { start: 0, end: 0 }, text: "---\ndatabase: true\n---\n" };
  // Insert just before the closing `---` line.
  const close = text.lastIndexOf("---", front.end - 1);
  return { range: { start: close, end: close }, text: "database: true\n" };
}

/**
 * Move block `index` so it sits before block `before` (`blocks.length` = last).
 *
 * Only the block texts trade places: the separators between them (blank
 * lines) keep their positions, so spacing never collapses. Null when the
 * block would not move.
 */
export function moveBlockEdit(text: string, blocks: readonly BlockRange[], index: number, before: number): TextEdit | null {
  if (index < 0 || index >= blocks.length || before < 0 || before > blocks.length || before === index || before === index + 1) return null;
  const low = Math.min(index, before);
  const high = before > index ? before - 1 : index;
  const pieces = blocks.slice(low, high + 1).map((block) => text.slice(block.from, block.to));
  const separators = blocks.slice(low, high).map((block, offset) => text.slice(block.to, blocks[low + offset + 1].from));
  const moved = pieces.splice(index - low, 1)[0];
  pieces.splice(before > index ? pieces.length : before - low, 0, moved);
  const joined = pieces.map((piece, offset) => piece + (separators[offset] ?? "")).join("");
  return { range: { start: blocks[low].from, end: blocks[high].to }, text: joined };
}

/** Insert a copy of the block right after it, separated by a blank line. */
export function duplicateBlockEdit(text: string, block: BlockRange): TextEdit {
  return { range: { start: block.to, end: block.to }, text: `\n\n${text.slice(block.from, block.to)}` };
}

/** Remove a block with the separator after it (or before it, for the last block). */
export function deleteBlockEdit(blocks: readonly BlockRange[], index: number): TextEdit {
  const block = blocks[index];
  const next = blocks[index + 1];
  if (next) return { range: { start: block.from, end: next.from }, text: "" };
  const previous = blocks[index - 1];
  return { range: { start: previous ? previous.to : block.from, end: block.to }, text: "" };
}
