// Exact half-open selection ranges for GUI edits (Issue #5).
//
// GUI Insert-mode typing and paste replace the precise selected span instead
// of silently collapsing it: reverse selections use min/max, Unicode and
// newline spans slice on UTF-16 offsets shared with the registry contract,
// and rapid bursts advance a single optimistic collapsed caret while a fresh
// noncollapsed selection is consumed once. A newer revision never reuses an
// old range automatically: `correspondRange` admits exactly one retry only
// when the fresh text still holds the captured slice at the clamped range.

export interface EditRange {
  start: number;
  end: number;
}

/**
 * Clamp an offset into `[0, length]`, truncating and flooring non-finite to 0.
 *
 * Untrusted GUI offsets always clamp; the optimistic caret itself never clamps
 * so rapid input at EOF does not collapse and reverse.
 */
function clampOffset(value: number, length: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), length);
}

/**
 * Resolve the range one edit applies to. A fresh noncollapsed selection
 * (optimistic caret still equals its head) is replaced once; otherwise the
 * edit lands at the optimistic caret. The optimistic caret is the shell's own
 * projection for its queued edits and is never clamped to the known text:
 * clamping would collapse rapid input on an empty document (or at EOF) to a
 * single offset and reverse it. Out-of-range projections fail visibly at the
 * registry instead of corrupting order. Untrusted selected offsets are always
 * clamped.
 */
export function resolveEditRange(
  textLength: number,
  anchor: number,
  head: number,
  optimisticCaret?: number,
): EditRange {
  const length = Math.max(textLength, 0);
  const a = clampOffset(anchor, length);
  const h = clampOffset(head, length);
  if (a !== h && optimisticCaret === h) {
    return { start: Math.min(a, h), end: Math.max(a, h) };
  }
  if (optimisticCaret !== undefined && Number.isFinite(optimisticCaret)) {
    return { start: Math.trunc(optimisticCaret), end: Math.trunc(optimisticCaret) };
  }
  return { start: h, end: h };
}

/** Slice the selected span for display or capture. */
export function sliceRange(text: string, range: EditRange): string {
  const start = clampOffset(range.start, text.length);
  const end = clampOffset(range.end, text.length);
  if (start > end) return "";
  return text.slice(start, end);
}

/**
 * Admit a stale-rejected range for exactly one retry only when the fresh
 * source still equals the captured source in full. An unchanged excerpt at
 * the same offset alone is not enough: unrelated changes can shift repeated
 * text, so arbitrary stale offsets (collapsed or not) are rejected unless
 * full source equality proves correspondence.
 */
export function correspondSource(
  snapshotText: string,
  capturedText: string,
  range: EditRange,
): EditRange | null {
  if (snapshotText !== capturedText) return null;
  const start = clampOffset(range.start, snapshotText.length);
  const end = clampOffset(range.end, snapshotText.length);
  if (start > end) return null;
  return { start, end };
}
