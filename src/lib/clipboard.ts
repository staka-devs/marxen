import { invoke } from "@tauri-apps/api/core";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import type { Root, RootContent } from "hast";
import type { CopyFormat, YankCopy } from "../shared/contracts";
import { renderMarkdownDocument } from "./render/pipeline";
import { marxenSanitizeSchema } from "./render/sanitize-schema";
import { decodeImageSrc, isRelativeImageSrc } from "../components/preview/images";
import { htmlToRtf } from "./clipboard-rtf";
import { visit } from "unist-util-visit";
import { validateMathContent } from "./render/validate";
import { workspaceApi } from "./workspace";

/** Encode raw image bytes as a `data:` URL without blocking on large files. */
export function bytesToDataUrl(mime: string, bytes: ArrayLike<number>): string {
  let binary = "";
  const list = Array.from(bytes);
  for (let offset = 0; offset < list.length; offset += 0x8000) {
    binary += String.fromCharCode(...list.slice(offset, offset + 0x8000));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

export const COPY_LABELS: Record<CopyFormat, string> = {
  markdown: "Markdown",
  text: "装飾なしテキスト",
  rich: "リッチテキスト",
  html: "HTML ソース",
};

/** Markdown syntax is removed using its syntax tree, not regular expressions.
 * Code/math contents and Unicode stay intact. Tables retain row/column order. */
export function markdownToPlainText(source: string): string {
  const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
    .use(remarkRehype, { allowDangerousHtml: true }).use(rehypeRaw)
    .use(rehypeSanitize, marxenSanitizeSchema() as never);
  const tree = parser.runSync(parser.parse(source)) as Root;
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

export interface ClipboardPayload {
  text: string;
  html: string | null;
  rtf: string | null;
}

/** Clipboard HTML uses the same sanitized renderer as the editor. Add only
 * local inline styles, so paste targets don't need Marxen's stylesheet. */
export async function prepareClipboard(copy: YankCopy, resolveImage?: (path: string) => Promise<string | null>): Promise<ClipboardPayload> {
  if (copy.format === "markdown") return { text: copy.text, html: null, rtf: null };
  const plain = markdownToPlainText(copy.text);
  if (copy.format === "text") return { text: plain, html: null, rtf: null };
  const rendered = await renderMarkdownDocument(copy.text);
  const template = document.createElement("template");
  template.innerHTML = rendered.html;
  const mathSources: string[] = [];
  const mathTree = unified().use(remarkParse).use(remarkMath).parse(copy.text);
  visit(mathTree, (node) => {
    if ((node.type === "math" || node.type === "inlineMath") && "value" in node && validateMathContent(String(node.value)).ok) {
      mathSources.push(String(node.value));
    }
  });
  template.content.querySelectorAll("mjx-container").forEach((math, index) => {
    if (mathSources[index] !== undefined) math.setAttribute("data-marxen-tex", mathSources[index]);
  });
  for (const img of template.content.querySelectorAll<HTMLImageElement>("img")) {
    const source = img.getAttribute("src") ?? "";
    if (resolveImage && isRelativeImageSrc(source)) {
      const embedded = await resolveImage(decodeImageSrc(source));
      if (!embedded || !/^data:image\/(png|jpeg|gif|webp);base64,/i.test(embedded)) {
        throw new Error(`画像をコピーできません: ${decodeImageSrc(source)}`);
      }
      img.src = embedded;
    }
  }
  for (const pre of template.content.querySelectorAll<HTMLElement>("pre")) {
    pre.style.cssText = "white-space:pre-wrap;font-family:monospace;background:#f6f8fa;color:#24292f;padding:12px";
    for (const span of pre.querySelectorAll<HTMLElement>("span[style]")) {
      const light = span.style.getPropertyValue("--shiki-light");
      if (light) span.style.color = light;
    }
  }
  for (const table of template.content.querySelectorAll<HTMLElement>("table")) {
    table.style.borderCollapse = "collapse";
  }
  for (const cell of template.content.querySelectorAll<HTMLElement>("th,td")) {
    cell.style.cssText = "border:1px solid #d0d7de;padding:6px 12px";
  }
  for (const quote of template.content.querySelectorAll<HTMLElement>("blockquote")) {
    quote.style.cssText = "border-left:3px solid #d0d7de;padding-left:12px;margin-left:0";
  }
  // Native previews for diagrams/maps/3D do not travel with clipboard HTML;
  // the renderer's escaped source fallback remains visible and selectable.
  for (const details of template.content.querySelectorAll(".marxen-source")) {
    details.replaceWith(...Array.from(details.querySelector("pre")?.childNodes ?? []));
  }
  const html = template.innerHTML;
  return copy.format === "html" ? { text: html, html: null, rtf: null }
    : { text: plain, html, rtf: await htmlToRtf(template.content) };
}

/** Rust owns the native clipboard. This works after asynchronous formatting
 * and does not depend on a browser's transient key activation permission. */
export async function copyYankToClipboard(copy: YankCopy, documentId: string): Promise<void> {
  const payload = await prepareClipboard(copy, async (path) => {
    const data = await workspaceApi.loadImage(documentId, path);
    return bytesToDataUrl(data.mime, data.bytes);
  });
  await invoke<void>("write_clipboard", payload as unknown as Record<string, unknown>);
}
