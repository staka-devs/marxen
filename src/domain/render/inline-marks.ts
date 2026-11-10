// Inline Markdown spans for the block under the cursor (Issue #6).
//
// The live editor keeps the active block as raw source so Vim edits the real
// text. These spans let it style emphasis, code, strikethrough and links in
// place and hide their markers, without changing a single source offset.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { Nodes, Root as MdastRoot } from "mdast";

/** One styled inline span with the marker ranges around its content. */
export interface InlineMark {
  kind: "strong" | "emphasis" | "delete" | "code" | "link";
  /** Whole span including markers, `[from, to)` in the parsed text. */
  from: number;
  to: number;
  /** Visible content between the markers. */
  contentFrom: number;
  contentTo: number;
}

/** Start and end offsets of a node, if remark recorded them. */
function span(node: Nodes): [number, number] | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? null : [start, end];
}

/**
 * Inline spans of `text` in source order; nested spans are all returned.
 *
 * Offsets are UTF-16 indices into `text`. Spans without markers (bare URLs)
 * are styled but have empty marker ranges. Never throws.
 */
export function inlineMarks(text: string): InlineMark[] {
  let tree: MdastRoot;
  try {
    tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(text) as MdastRoot;
  } catch {
    return [];
  }
  const marks: InlineMark[] = [];
  /** Collect marks below one node. */
  const walk = (node: Nodes) => {
    const whole = span(node);
    if (whole && (node.type === "strong" || node.type === "emphasis" || node.type === "delete" || node.type === "link")) {
      const first = node.children[0] ? span(node.children[0]) : null;
      const last = node.children.at(-1) ? span(node.children.at(-1)!) : null;
      if (first && last) {
        marks.push({ kind: node.type, from: whole[0], to: whole[1], contentFrom: first[0], contentTo: last[1] });
      }
    } else if (whole && node.type === "inlineCode") {
      const ticks = /^`+/.exec(text.slice(whole[0], whole[1]))?.[0].length ?? 1;
      marks.push({ kind: "code", from: whole[0], to: whole[1], contentFrom: whole[0] + ticks, contentTo: whole[1] - ticks });
    }
    if ("children" in node) for (const child of node.children) walk(child as Nodes);
  };
  walk(tree);
  return marks;
}
