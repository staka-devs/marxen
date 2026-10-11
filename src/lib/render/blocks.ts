// Block ranges for the inline live editor (Issue #6, ADR-0061).
//
// The CodeMirror StateField maps these ranges to replacement decorations.
// `from` / `to` are UTF-16 offsets into the original Markdown string, which
// match CodeMirror positions exactly (surrogate pairs count as two units on
// both sides). Nothing here reserializes the document: widgets only read.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { Root as MdastRoot, Content as MdastContent } from "mdast";

export interface LiveBlock {
  /** `heading`, `paragraph`, `code`, `math`, `table`, `list`, `blockquote`, `alert:note`, `html`, `thematicBreak`. */
  kind: string;
  /** UTF-16 offsets into the original source, `[from, to)`. */
  from: number;
  to: number;
  /** 1-based inclusive source lines. */
  startLine: number;
  endLine: number;
  lang?: string;
  alert?: string;
  title?: string;
}

function mdastText(node: MdastContent): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if ("children" in node && Array.isArray(node.children)) {
    return (node.children as MdastContent[]).map(mdastText).join("");
  }
  return "";
}

function alertKind(node: MdastContent): string | null {
  if (node.type !== "blockquote") return null;
  const first = node.children[0];
  if (!first || first.type !== "paragraph") return null;
  const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.exec(mdastText(first).trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * Top-level block ranges with exact UTF-16 offsets. Footnote definitions
 * are excluded: they are link metadata and always edit as raw source.
 * Never throws; falls back to a single raw paragraph span.
 */
export function computeLiveBlocks(source: string): LiveBlock[] {
  try {
    const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(source) as MdastRoot;
    const blocks: LiveBlock[] = [];
    for (const node of tree.children) {
      const position = node.position;
      if (!position || position.start.offset === undefined || position.end.offset === undefined) continue;
      const from = position.start.offset;
      const to = position.end.offset;
      const startLine = position.start.line;
      const endLine = position.end.line;
      switch (node.type) {
        case "heading":
          blocks.push({ kind: "heading", from, to, startLine, endLine, title: mdastText(node).slice(0, 60) });
          break;
        case "code":
          blocks.push({ kind: "code", from, to, startLine, endLine, lang: node.lang?.toLowerCase() });
          break;
        case "math":
          blocks.push({ kind: "math", from, to, startLine, endLine });
          break;
        case "table":
          blocks.push({ kind: "table", from, to, startLine, endLine });
          break;
        case "list":
          blocks.push({ kind: "list", from, to, startLine, endLine });
          break;
        case "blockquote": {
          const alert = alertKind(node);
          blocks.push({ kind: alert ? `alert:${alert}` : "blockquote", from, to, startLine, endLine, alert: alert ?? undefined });
          break;
        }
        case "paragraph":
          blocks.push({ kind: "paragraph", from, to, startLine, endLine, title: mdastText(node).slice(0, 60) });
          break;
        case "html":
          blocks.push({ kind: "html", from, to, startLine, endLine });
          break;
        case "thematicBreak":
          blocks.push({ kind: "thematicBreak", from, to, startLine, endLine });
          break;
        case "footnoteDefinition":
          break;
        default:
          blocks.push({ kind: node.type, from, to, startLine, endLine });
          break;
      }
    }
    return blocks;
  } catch {
    return source === "" ? [] : [{ kind: "paragraph", from: 0, to: source.length, startLine: 1, endLine: source.split("\n").length }];
  }
}

const DEFINITION_LINE = /^\s{0,3}(?:\[[^^[\]]+\]|\[\^[^\]]+\]):/;

/**
 * Link / footnote definition lines, appended to a block's render source so
 * reference-style links and footnote refs resolve inside isolated widgets.
 * Render-only: source offsets are unaffected.
 */
export function extractLinkDefinitions(source: string): string {
  return source
    .split("\n")
    .filter((line) => DEFINITION_LINE.test(line))
    .join("\n");
}

interface TableCell {
  /** Absolute UTF-16 offsets of the trimmed cell content. */
  from: number;
  to: number;
  /** Raw cell text (trimmed). */
  text: string;
}

function splitRowCells(line: string): Array<{ start: number; end: number }> {
  // Returns UTF-16 spans (relative to the line) of each cell, honouring
  // escaped pipes (`\|`) and backtick code spans that may contain `|`.
  const spans: Array<{ start: number; end: number }> = [];
  let i = 0;
  const end = line.length;
  // Optional leading pipe creates an ignored edge cell.
  if (line[i] === "|") i += 1;
  let cellStart = i;
  const push = () => {
    spans.push({ start: cellStart, end: i });
    cellStart = i + 1;
  };
  while (i < end) {
    const char = line[i];
    if (char === "\\" && i + 1 < end) {
      i += 2;
      continue;
    }
    if (char === "`") {
      let run = 1;
      while (i + run < end && line[i + run] === "`") run += 1;
      const closer = line.indexOf("`".repeat(run), i + run);
      if (closer >= 0) {
        i = closer + run;
        continue;
      }
      i += run;
      continue;
    }
    if (char === "|") {
      push();
      i += 1;
      continue;
    }
    i += 1;
  }
  // Optional trailing pipe: drop the empty edge cell it would create.
  if (cellStart < end || line[end - 1] !== "|") spans.push({ start: cellStart, end });
  return spans;
}

/**
 * Locate the source span of a rendered table cell. `tableSource` is the
 * block's exact source, `blockFrom` its absolute offset, `row` counts data
 * rows (0 = header, then body rows skipping the delimiter), `col` is
 * 0-based. Returns the trimmed content span so surrounding padding and
 * escaped pipes survive a replacement. Returns null when out of range.
 */
export function findTableCellRange(
  tableSource: string,
  blockFrom: number,
  row: number,
  col: number,
): TableCell | null {
  const lines = tableSource.split("\n");
  const lineIndex = row === 0 ? 0 : row + 1;
  if (lineIndex < 0 || lineIndex >= lines.length) return null;
  if (row > 0 && !/^\s*\|?[\s:|-]+\|?[\s:|-]*\s*$/.test(lines[1] ?? "")) return null;
  const line = lines[lineIndex];
  const cells = splitRowCells(line);
  if (col < 0 || col >= cells.length) return null;
  const raw = line.slice(cells[col].start, cells[col].end);
  const leading = raw.match(/^\s*/)?.[0].length ?? 0;
  const trailing = raw.match(/\s*$/)?.[0].length ?? 0;
  let lineOffset = 0;
  for (let i = 0; i < lineIndex; i += 1) lineOffset += lines[i].length + 1;
  const contentStart = cells[col].start + leading;
  const contentEnd = Math.max(contentStart, cells[col].end - trailing);
  return {
    from: blockFrom + lineOffset + contentStart,
    to: blockFrom + lineOffset + contentEnd,
    text: line.slice(contentStart, contentEnd),
  };
}
