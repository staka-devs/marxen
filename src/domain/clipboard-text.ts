// Deterministic clipboard text helpers (domain).
//
// Byte encoding, format labels, and Markdown-to-plain conversion. No Tauri,
// DOM, React, or browser globals: HTML/RTF building and native writes live in
// infrastructure clipboard.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import type { Root, RootContent } from "hast";
import type { CopyFormat } from "../contracts/contracts";
import { marxenSanitizeSchema } from "./render/sanitize-schema";

/** Clipboard payload with plain text and optional rich representations. */
export interface ClipboardPayload {
  text: string;
  html: string | null;
  rtf: string | null;
}

/**
 * Encode image bytes as a data URL in chunks to avoid argument limits.
 *
 * Spreads 32k code units at a time so large images never overflow `apply`.
 */
export function bytesToDataUrl(mime: string, bytes: ArrayLike<number>): string {
  let binary = "";
  const list = Array.from(bytes);
  for (let offset = 0; offset < list.length; offset += 0x8000) {
    binary += String.fromCharCode(...list.slice(offset, offset + 0x8000));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/** Japanese labels for yank copy formats shown in the footer. */
export const COPY_LABELS: Record<CopyFormat, string> = {
  markdown: "Markdown",
  text: "装飾なしテキスト",
  rich: "リッチテキスト",
  html: "HTML ソース",
};

/**
 * Strip Markdown syntax to plain text via its syntax tree, not regex.
 *
 * Code/math contents and Unicode stay intact; tables keep row/column order
 * with tab/newline separators; images reduce to alt text.
 */
export function markdownToPlainText(source: string): string {
  const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
    .use(remarkRehype, { allowDangerousHtml: true }).use(rehypeRaw)
    .use(rehypeSanitize, marxenSanitizeSchema() as never);
  const tree = parser.runSync(parser.parse(source)) as Root;
  /** Recursively extract display text from a hast subtree. */
  const text = (node: Root | RootContent): string => {
    if ("value" in node) return node.value;
    if (!("children" in node)) return "";
    const tag = node.type === "element" ? node.tagName : "root";
    if (node.type === "element" && tag === "img") return String(node.properties.alt ?? "");
    if (tag === "br" || tag === "hr") return "\n";
    if (node.type === "element" && tag === "input" && node.properties.type === "checkbox") {
      return node.properties.checked ? "[x]" : "[ ]";
    }
    const inline = ["p", "span", "a", "strong", "em", "del", "code", "pre", "li", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6"].includes(tag);
    const parts = node.children.filter((child) => inline || child.type !== "text" || child.value.trim() !== "")
      .map((child) => text(child as RootContent));
    if (tag === "root" || tag === "blockquote") return parts.filter(Boolean).join("\n\n");
    if (["table", "thead", "tbody", "ul", "ol"].includes(tag)) return parts.join("\n");
    if (tag === "tr") return parts.join("\t");
    return parts.join("");
  };
  const result = text(tree);
  return source.endsWith("\n") && !result.endsWith("\n") ? result + "\n" : result;
}
