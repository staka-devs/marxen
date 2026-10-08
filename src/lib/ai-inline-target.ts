// Inline target resolution: explicit selection wins, otherwise the current
// paragraph (blank-line delimited) around the caret. Ranges stay UTF-16
// half-open offsets into the full document text so the exact base context is
// preserved for Rust authorization.

export interface InlineTarget {
  start: number;
  end: number;
  kind: "selection" | "paragraph";
  excerpt: string;
}

function clampOffset(text: string, offset: number): number {
  if (!Number.isInteger(offset)) return 0;
  return Math.max(0, Math.min(text.length, offset));
}

function isBoundarySafe(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const prev = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  const high = prev >= 0xd800 && prev <= 0xdbff;
  const low = next >= 0xdc00 && next <= 0xdfff;
  return !(high && low);
}

function snapToBoundary(text: string, offset: number): number {
  let next = clampOffset(text, offset);
  if (!isBoundarySafe(text, next) && next > 0) next -= 1;
  return next;
}

function paragraphAround(text: string, caret: number): { start: number; end: number } {
  const at = clampOffset(text, caret);
  let start = 0;
  const before = text.lastIndexOf("\n\n", Math.max(0, at - 1));
  if (before >= 0) start = before + 2;
  else {
    const single = text.lastIndexOf("\n", Math.max(0, at - 1));
    // A lone newline does not split paragraphs; only blank lines do. Keep
    // the scan anchored on double newlines and fall back to document start.
    if (single >= 0 && text.slice(Math.max(0, single - 1), single + 1) === "\n\n") start = single + 1;
  }
  let end = text.length;
  const after = text.indexOf("\n\n", at);
  if (after >= 0) end = after;
  // Trim one trailing newline so the excerpt stays a clean paragraph.
  if (end > start && text[end - 1] === "\n") end -= 1;
  return { start: snapToBoundary(text, start), end: snapToBoundary(text, end) };
}

export function resolveInlineTarget(
  text: string,
  anchor: number,
  head: number,
): InlineTarget {
  const start = snapToBoundary(text, Math.min(clampOffset(text, anchor), clampOffset(text, head)));
  const end = snapToBoundary(text, Math.max(clampOffset(text, anchor), clampOffset(text, head)));
  if (end > start) {
    return { start, end, kind: "selection", excerpt: text.slice(start, end) };
  }
  const paragraph = paragraphAround(text, start);
  if (paragraph.end <= paragraph.start) {
    return { start, end: start, kind: "paragraph", excerpt: "" };
  }
  return {
    start: paragraph.start,
    end: paragraph.end,
    kind: "paragraph",
    excerpt: text.slice(paragraph.start, paragraph.end),
  };
}
