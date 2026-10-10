// Shared mdast text helpers for render block mapping (Issue #14).
//
// `computeLiveBlocks` (blocks.ts, UTF-16 offsets for CodeMirror widgets) and
// `parseMarkdownBlocks` (pipeline.ts, 1-based lines for live/read mapping)
// need the same heading/alert titles but different coordinate contracts.
// Only the text extraction and alert-kind detection are shared here; the
// three entry points (outline/blocks/pipeline) stay separate.

import type { Content as MdastContent } from "mdast";

/**
 * Extract concatenated text from an mdast node for titles and alerts.
 *
 * Recurses through children; text/inlineCode contribute values directly.
 */
export function mdastText(node: MdastContent): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if ("children" in node && Array.isArray(node.children)) {
    return (node.children as MdastContent[]).map(mdastText).join("");
  }
  return "";
}

/**
 * Detect GitHub alert kind (`note|tip|important|warning|caution`) from a blockquote.
 *
 * Returns lowercase kind or null for ordinary quotes; case-insensitive.
 */
export function alertKind(node: MdastContent): string | null {
  if (node.type !== "blockquote") return null;
  const first = node.children[0];
  if (!first || first.type !== "paragraph") return null;
  const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.exec(mdastText(first).trim());
  return match ? match[1].toLowerCase() : null;
}
