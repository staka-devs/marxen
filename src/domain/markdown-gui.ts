// GUI range patches for Markdown. Every helper returns wire `TextEdit`
// ranges ([start, end) UTF-16) so callers never reserialize the document.
// The Rust actor owns application, revision bumps, and Undo sharing.

import { lineRangeAt } from "./coordinates/utf16";
import type { TextEdit } from "../contracts/contracts";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { Root, RootContent } from "mdast";

const proseParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

/** Find a paragraph containing the caret, excluding nested code and structural blocks. */
function proseAt(node: Root | RootContent, offset: number): boolean {
  if (node.type === "paragraph") return (node.position?.start.offset ?? Infinity) <= offset && offset <= (node.position?.end.offset ?? -1);
  if (!["root", "list", "listItem", "blockquote"].includes(node.type) || !("children" in node)) return false;
  return node.children.some((child) => proseAt(child as RootContent, offset));
}

/**
 * Build a single wire edit for a range replacement.
 *
 * Thin constructor keeping helpers free of inline object shapes.
 */
function edit(start: number, end: number, text: string): TextEdit {
  return { range: { start, end }, text };
}

const CHECKED = /^(-\s+\[)[xX](\].*)$/;
const UNCHECKED = /^(-\s+\[)(\s)(\].*)$/;
const BULLET = /^(\s*)-\s+(.*)$/;

export type FormatKind = "bold" | "italic" | "strike" | "code";

/** Toggle `- [ ]` / `- [x]` on the line containing `offset`. */
export function toggleCheckbox(text: string, offset: number): TextEdit[] {
  const { start, end, line } = lineRangeAt(text, offset);
  let next: string | null = null;
  if (CHECKED.test(line)) next = line.replace(CHECKED, "$1 $2");
  else if (UNCHECKED.test(line)) next = line.replace(UNCHECKED, "$1x$3");
  else if (BULLET.test(line)) next = line.replace(BULLET, "$1- [ ] $2");
  else next = `- [ ] ${line}`;
  return [edit(start, end, next)];
}

const MARKERS: Record<FormatKind, [string, string]> = {
  bold: ["**", "**"],
  italic: ["*", "*"],
  strike: ["~~", "~~"],
  code: ["`", "`"],
};

/** Wrap (or unwrap) [start, end) with the format markers. */
export function formatRange(text: string, start: number, end: number, kind: FormatKind): TextEdit[] {
  if (start > end) throw new RangeError(`reversed range [${start}, ${end})`);
  if (start < 0 || end > text.length) throw new RangeError("range out of bounds");
  const [open, close] = MARKERS[kind];
  const selected = text.slice(start, end);
  if (selected.startsWith(open) && selected.endsWith(close) && selected.length >= open.length + close.length) {
    return [edit(start, end, selected.slice(open.length, selected.length - close.length))];
  }
  if (selected.length === 0) {
    // Empty selection: insert a paired marker pair and leave the caret between.
    return [edit(start, end, `${open}${close}`)];
  }
  return [edit(start, end, `${open}${selected}${close}`)];
}

/** Wrap the selection (or insert at caret) as a Markdown link. */
export function insertLink(text: string, start: number, end: number, url: string): TextEdit[] {
  const safe = url.trim();
  if (safe === "") throw new RangeError("url must not be empty");
  const selected = text.slice(start, end);
  if (selected.length === 0) return [edit(start, end, `[](${safe})`)];
  return [edit(start, end, `[${selected}](${safe})`)];
}

/** Insert an image (or wrap selection as alt text) at [start, end). */
export function insertImage(text: string, start: number, end: number, src: string, alt?: string): TextEdit[] {
  const safe = src.trim();
  if (safe === "") throw new RangeError("src must not be empty");
  const selected = text.slice(start, end);
  const label = selected.length > 0 ? selected : (alt ?? "画像");
  return [edit(start, end, `![${label}](${safe})`)];
}

/** Insert a table at `offset` (caret). Ends with a trailing newline. */
export function insertTable(offset: number, rows: number, cols: number, heading = "Header"): TextEdit[] {
  if (!Number.isInteger(rows) || rows < 1 || rows > 20) throw new RangeError("rows must be 1..20");
  if (!Number.isInteger(cols) || cols < 1 || cols > 10) throw new RangeError("cols must be 1..10");
  const header = `|${` ${heading} |`.repeat(cols)}`;
  const separator = `|${" --- |".repeat(cols)}`;
  const body = Array.from({ length: rows }, () => `|${"  |".repeat(cols)}`).join("\n");
  return [edit(offset, offset, `${header}\n${separator}\n${body}\n`)];
}

/** Split source cells while honoring escaped pipes and exact backtick runs. */
export function splitTableRowCells(line: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const end = line.trimEnd().length;
  let i = line.match(/^\s*/)?.[0].length ?? 0;
  if (line[i] === "|") i += 1;
  let start = i;
  while (i < end) {
    if (line[i] === "\\") { i += 2; continue; }
    if (line[i] === "`") {
      let run = 1;
      while (line[i + run] === "`") run += 1;
      let close = i + run;
      while (close < end) {
        if (line[close] !== "`") { close += 1; continue; }
        let width = 1;
        while (line[close + width] === "`") width += 1;
        if (width === run) break;
        close += width;
      }
      i = close < end ? close + run : i + run;
      continue;
    }
    if (line[i] === "|") { spans.push({ start, end: i }); start = i + 1; }
    i += 1;
  }
  if (start < end || line[end - 1] !== "|") spans.push({ start, end });
  return spans;
}

/** Exclude fenced/indented code and structural Markdown from prose Enter. */
export function hardBreakSpaces(text: string, anchor: number, head: number): string | null {
  if (anchor !== head || head < 0 || head > text.length) return null;
  const { end, line } = lineRangeAt(text, head);
  if (head !== end || line.trim() === "") return null;
  if (!proseAt(proseParser.parse(text) as Root, head)) return null;
  if (/(?:^|[^\\])(?:\\\\)*\\$/.test(line)) return "";
  const spaces = / *$/.exec(line)![0].length;
  return " ".repeat(Math.max(0, 2 - spaces));
}

/** Recognize table rows with optional edge pipes and intact code spans. */
function isTableLine(line: string): boolean {
  return line.includes("|") && splitTableRowCells(line).length > 0 && !/^(?: {4}|\t)/.test(line);
}

/** Consecutive `|...|` lines containing `offset`, or null when not in a table. */
export function tableBlockAt(text: string, offset: number): { startLine: number; endLine: number } | null {
  const lines = text.split("\n");
  // Locate the line index from the global offset.
  let remaining = offset;
  let lineIndex = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (remaining <= lines[i].length) {
      lineIndex = i;
      break;
    }
    remaining -= lines[i].length + 1;
    lineIndex = i;
  }
  if (!isTableLine(lines[lineIndex] ?? "")) return null;
  let startLine = lineIndex;
  while (startLine - 1 >= 0 && isTableLine(lines[startLine - 1])) startLine -= 1;
  let endLine = lineIndex;
  while (endLine + 1 < lines.length && isTableLine(lines[endLine + 1])) endLine += 1;
  const header = splitTableRowCells(lines[startLine]);
  const separator = splitTableRowCells(lines[startLine + 1] ?? "");
  if (endLine <= startLine || header.length !== separator.length || !separator.every((cell) => /^\s*:?-{3,}:?\s*$/.test(lines[startLine + 1].slice(cell.start, cell.end)))) return null;
  if (lines.slice(startLine, endLine + 1).some((line) => splitTableRowCells(line).length !== header.length)) return null;
  if (!(proseParser.parse(text) as Root).children.some((node) => node.type === "table" && (node.position?.start.offset ?? Infinity) <= offset && offset <= (node.position?.end.offset ?? -1))) return null;
  return { startLine, endLine };
}

/**
 * Compute the global offset of a 0-based line index for table edits.
 *
 * Sums preceding line lengths plus newlines; used for row insert/delete.
 */
function lineStartOffset(text: string, lineIndex: number): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < lineIndex; i += 1) offset += lines[i].length + 1;
  return offset;
}

/** Insert an empty row after the table row at `offset`. */
export function tableAddRow(text: string, offset: number, position: "above" | "below" = "below"): TextEdit[] {
  const cell = requireTableCell(text, offset);
  const target = Math.max(cell.startLine + 2, cell.lineIndex + (position === "below" ? 1 : 0));
  const at = lineStartOffset(text, target);
  const row = `|${"  |".repeat(cell.columns)}`;
  return [edit(Math.min(at, text.length), Math.min(at, text.length), at > text.length ? `\n${row}` : `${row}\n`)];
}

/** Append one empty cell to every row of the table at `offset`. */
export function tableAddColumn(text: string, offset: number, position: "left" | "right" = "right"): TextEdit[] {
  const cell = requireTableCell(text, offset);
  const lines = text.split("\n");
  const edits: TextEdit[] = [];
  for (let i = cell.startLine; i <= cell.endLine; i += 1) {
    const start = lineStartOffset(text, i);
    const span = splitTableRowCells(lines[i])[cell.column];
    const content = i === cell.startLine + 1 ? " --- " : "  ";
    const at = start + (position === "left" ? span.start : span.end);
    edits.push(edit(at, at, position === "left" ? `${content}|` : `|${content}`));
  }
  // Ascending, non-adjacent by construction (separate lines).
  return edits;
}

/** Delete the table row at `offset` (never the separator). */
export function tableDeleteRow(text: string, offset: number): TextEdit[] {
  const cell = requireTableCell(text, offset);
  const lines = text.split("\n");
  const idx = cell.lineIndex;
  if (idx <= cell.startLine + 1) throw new RangeError("cannot delete the table header");
  const start = lineStartOffset(text, idx);
  const end = idx + 1 < lines.length ? lineStartOffset(text, idx + 1) : text.length;
  return [edit(start, end, "")];
}

/** Selected source cell and structural table bounds. */
export interface TableCellContext {
  startLine: number;
  endLine: number;
  lineIndex: number;
  column: number;
  columns: number;
  alignment: "none" | "left" | "center" | "right";
}

/** Locate the selected column without splitting escaped pipes or code. */
export function tableCellAt(text: string, offset: number): TableCellContext | null {
  const block = tableBlockAt(text, offset);
  if (!block) return null;
  const { start, line } = lineRangeAt(text, offset);
  const lineIndex = text.slice(0, start).split("\n").length - 1;
  const cells = splitTableRowCells(line);
  const found = cells.findIndex((cell) => offset - start <= cell.end);
  const column = found < 0 ? cells.length - 1 : found;
  const delimiter = text.split("\n")[block.startLine + 1];
  const separator = splitTableRowCells(delimiter)[column];
  const token = delimiter.slice(separator.start, separator.end).trim();
  const alignment = token.startsWith(":") ? (token.endsWith(":") ? "center" : "left") : (token.endsWith(":") ? "right" : "none");
  return { ...block, lineIndex, column, columns: cells.length, alignment };
}

/** Reject operations outside a structurally valid Markdown table. */
function requireTableCell(text: string, offset: number): TableCellContext {
  const cell = tableCellAt(text, offset);
  if (!cell) throw new RangeError("not in a table");
  return cell;
}

/** Delete one selected column; deleting the last column removes the table. */
export function tableDeleteColumn(text: string, offset: number): TextEdit[] {
  const cell = requireTableCell(text, offset);
  const lines = text.split("\n");
  if (cell.columns === 1) return [edit(lineStartOffset(text, cell.startLine), Math.min(text.length, lineStartOffset(text, cell.endLine + 1)), "")];
  return lines.slice(cell.startLine, cell.endLine + 1).map((line, index) => {
    const spans = splitTableRowCells(line);
    const span = spans[cell.column];
    const start = lineStartOffset(text, cell.startLine + index);
    return cell.column < cell.columns - 1 ? edit(start + span.start, start + spans[cell.column + 1].start, "") : edit(start + spans[cell.column - 1].end, start + span.end, "");
  });
}

/** Set only the selected column's delimiter token, preserving cell bytes. */
export function tableAlignColumn(text: string, offset: number, alignment: TableCellContext["alignment"]): TextEdit[] {
  const cell = requireTableCell(text, offset);
  const line = text.split("\n")[cell.startLine + 1];
  const span = splitTableRowCells(line)[cell.column];
  const start = lineStartOffset(text, cell.startLine + 1);
  const raw = line.slice(span.start, span.end);
  const leading = /^\s*/.exec(raw)![0].length;
  const trailing = /\s*$/.exec(raw)![0].length;
  const marker = { none: "---", left: ":---", center: ":---:", right: "---:" }[alignment];
  return [edit(start + span.start + leading, start + span.end - trailing, marker)];
}

/** Select the adjacent source cell for explicit Tab/Shift+Tab navigation. */
export function adjacentTableCell(text: string, offset: number, backwards: boolean): { anchor: number; head: number } | null {
  const cell = tableCellAt(text, offset);
  if (!cell || cell.lineIndex === cell.startLine + 1) return null;
  const lines = text.split("\n");
  const rows = Array.from({ length: cell.endLine - cell.startLine + 1 }, (_, index) => index + cell.startLine).filter((index) => index !== cell.startLine + 1);
  const next = rows.indexOf(cell.lineIndex) * cell.columns + cell.column + (backwards ? -1 : 1);
  if (next < 0 || next >= rows.length * cell.columns) return null;
  const row = rows[Math.floor(next / cell.columns)];
  const span = splitTableRowCells(lines[row])[next % cell.columns];
  const raw = lines[row].slice(span.start, span.end);
  const start = lineStartOffset(text, row);
  const anchor = start + span.start + /^\s*/.exec(raw)![0].length;
  return { anchor, head: Math.max(anchor, start + span.end - /\s*$/.exec(raw)![0].length) };
}

/** Whether the line at `offset` is a Markdown list item (bullet, ordered or task), outside fenced code. */
export function isListItemAt(text: string, offset: number): boolean {
  const before = text.slice(0, offset);
  const fences = before.match(/^ {0,3}(```|~~~)/gm)?.length ?? 0;
  if (fences % 2 === 1) return false;
  const start = before.lastIndexOf("\n") + 1;
  const end = text.indexOf("\n", offset);
  return /^[ \t]*([-*+]|\d{1,9}[.)])[ \t]/.test(text.slice(start, end < 0 ? text.length : end));
}

/** Structural actions supported by the contextual table controls. */
export type TableAction = "row-above" | "row-below" | "column-left" | "column-right" | "delete-row" | "delete-column" | "align-none" | "align-left" | "align-center" | "align-right";

/** Dispatch a structural action using the captured source cell. */
export function tableActionEdits(text: string, offset: number, action: TableAction): TextEdit[] {
  switch (action) {
    case "row-above": return tableAddRow(text, offset, "above");
    case "row-below": return tableAddRow(text, offset, "below");
    case "column-left": return tableAddColumn(text, offset, "left");
    case "column-right": return tableAddColumn(text, offset, "right");
    case "delete-row": return tableDeleteRow(text, offset);
    case "delete-column": return tableDeleteColumn(text, offset);
    default: return tableAlignColumn(text, offset, action.slice(6) as TableCellContext["alignment"]);
  }
}
