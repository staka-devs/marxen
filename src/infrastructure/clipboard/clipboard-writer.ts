// Native clipboard writer via Tauri (infrastructure).
//
// Clipboard HTML uses the same sanitized renderer as the editor with local
// inline styles only. Rust owns the native clipboard after async formatting,
// so this works without browser activation permission. Image bytes embed
// in-place for Word/Outlook via RTF.

import { invoke } from "@tauri-apps/api/core";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import { visit } from "unist-util-visit";
import type { YankCopy } from "../../contracts/contracts";
import { renderMarkdownDocument } from "../../domain/render/pipeline";
import { decodeImageSrc, isRelativeImageSrc } from "../../domain/image-sources";
import { markdownToPlainText, bytesToDataUrl, type ClipboardPayload } from "../../domain/clipboard-text";
import { validateMathContent } from "../../domain/render/validate";
import { htmlToRtf } from "./rtf";
import { workspaceApi } from "../tauri/workspace-api";
import type { ClipboardGateway } from "../../application/ports";

/**
 * Build the clipboard payload for a yank, embedding relative images.
 *
 * Markdown stays raw; text strips syntax; HTML/Rich reuse the sanitized
 * renderer with inlined code/table/quote styles. Relative images resolve
 * through the Rust loader and must be bytes-backed, or the copy throws.
 * Diagram/map/3D previews keep their escaped source fallback.
 */
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

/**
 * Copy a yank to the native clipboard through Rust.
 *
 * Resolves relative images via the document loader to data URLs, then writes
 * through `write_clipboard` without depending on browser key activation.
 */
export async function copyYankToClipboard(copy: YankCopy, documentId: string): Promise<void> {
  const payload = await prepareClipboard(copy, async (path) => {
    const data = await workspaceApi.loadImage(documentId, path);
    return bytesToDataUrl(data.mime, data.bytes);
  });
  await invoke<void>("write_clipboard", payload as unknown as Record<string, unknown>);
}


/** Clipboard gateway adapter satisfying the application port through Rust. */
export const clipboardGateway: ClipboardGateway = {
  /** Copy a yank through Rust without browser activation permission. */
  copyYank: copyYankToClipboard,
};

