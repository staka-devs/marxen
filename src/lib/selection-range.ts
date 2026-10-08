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

function clampOffset(value: number, length: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), length);
}

/**
 * Resolve the range one edit applies to. A fresh noncollapsed selection
 * (optimistic caret still equals its head) is replaced once; otherwise the
 * edit lands at the collapsed optimistic caret (rapid bursts) or head.
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
  const c = optimisticCaret === undefined ? undefined : clampOffset(optimisticCaret, length);
  if (a !== h && c === h) {
    return { start: Math.min(a, h), end: Math.max(a, h) };
  }
  const at = c ?? h;
  return { start: at, end: at };
}

/** Slice the selected span for safe-retry correspondence checks. */
export function sliceRange(text: string, range: EditRange): string {
  const start = clampOffset(range.start, text.length);
  const end = clampOffset(range.end, text.length);
  if (start > end) return "";
  return text.slice(start, end);
}

/**
 * Admit a stale-rejected range for exactly one retry only when the fresh
 * text still holds the captured slice at the clamped range. Collapsed carets
 * (empty capture) always correspond after clamping; mismatches report null so
 * the caller surfaces stale instead of reusing the old range.
 */
export function correspondRange(
  snapshotText: string,
  range: EditRange,
  beforeText: string,
): EditRange | null {
  const start = clampOffset(range.start, snapshotText.length);
  const end = clampOffset(range.end, snapshotText.length);
  if (start > end) return null;
  if (snapshotText.slice(start, end) !== beforeText) return null;
  return { start, end };
}
