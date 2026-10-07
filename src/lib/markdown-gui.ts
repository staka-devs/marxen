// GUI range patches for Markdown. Every helper returns wire `TextEdit`
// ranges ([start, end) UTF-16) so callers never reserialize the document.
// The Rust actor owns application, revision bumps, and Undo sharing.

import { lineRangeAt } from "./utf16";
import type { TextEdit } from "../shared/contracts";

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
export function insertTable(offset: number, rows: number, cols: number): TextEdit[] {
  if (!Number.isInteger(rows) || rows < 1 || rows > 20) throw new RangeError("rows must be 1..20");
  if (!Number.isInteger(cols) || cols < 1 || cols > 10) throw new RangeError("cols must be 1..10");
  const header = `|${" 見出し |".repeat(cols)}`;
  const separator = `|${" --- |".repeat(cols)}`;
  const body = Array.from({ length: rows }, () => `|${"  |".repeat(cols)}`).join("\n");
  return [edit(offset, offset, `${header}\n${separator}\n${body}\n`)];
}

function isTableLine(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
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
  return { startLine, endLine };
}

function lineStartOffset(text: string, lineIndex: number): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < lineIndex; i += 1) offset += lines[i].length + 1;
  return offset;
}

/** Insert an empty row after the table row at `offset`. */
export function tableAddRow(text: string, offset: number): TextEdit[] {
  const block = tableBlockAt(text, offset);
  if (!block) throw new RangeError("not in a table");
  const lines = text.split("\n");
  const { line } = lineRangeAt(text, offset);
  // Count columns from the current row (fallback to the header width).
  const cols = Math.max(1, line.split("|").length - 2);
  const currentIndex = (() => {
    let idx = 0;
    let rest = offset;
    for (let i = 0; i < lines.length; i += 1) {
      if (rest <= lines[i].length) {
        idx = i;
        break;
      }
      rest -= lines[i].length + 1;
    }
    return idx;
  })();
  const insertAtLine = currentIndex + 1;
  // Never insert between the header and its separator: push after the separator.
  const headerSeparator = block.startLine + 1;
  const targetLine = insertAtLine === headerSeparator ? headerSeparator + 1 : insertAtLine;
  const at = lineStartOffset(text, targetLine);
  return [edit(at, at, `|${"  |".repeat(cols)}\n`)];
}

/** Append one empty cell to every row of the table at `offset`. */
export function tableAddColumn(text: string, offset: number): TextEdit[] {
  const block = tableBlockAt(text, offset);
  if (!block) throw new RangeError("not in a table");
  const lines = text.split("\n");
  const edits: TextEdit[] = [];
  for (let i = block.startLine; i <= block.endLine; i += 1) {
    const start = lineStartOffset(text, i);
    const end = start + lines[i].length;
    const trimmed = lines[i].trimEnd();
    if (/---/.test(trimmed)) {
      edits.push(edit(end, end, " --- |"));
    } else {
      // Insert before the closing pipe to keep `| a | b |` shape.
      const closing = lines[i].lastIndexOf("|");
      const at = start + (closing >= 0 ? closing : lines[i].length);
      edits.push(edit(at, at, "  |"));
    }
  }
  // Ascending, non-adjacent by construction (separate lines).
  return edits;
}

/** Delete the table row at `offset` (never the separator). */
export function tableDeleteRow(text: string, offset: number): TextEdit[] {
  const block = tableBlockAt(text, offset);
  if (!block) throw new RangeError("not in a table");
  const lines = text.split("\n");
  let idx = 0;
  let rest = offset;
  for (let i = 0; i < lines.length; i += 1) {
    if (rest <= lines[i].length) {
      idx = i;
      break;
    }
    rest -= lines[i].length + 1;
  }
  if (idx === block.startLine + 1) throw new RangeError("cannot delete the separator row");
  const start = lineStartOffset(text, idx);
  const end = idx + 1 < lines.length ? lineStartOffset(text, idx + 1) : text.length;
  return [edit(start, end, "")];
}
