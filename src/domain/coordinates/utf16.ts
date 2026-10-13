// UTF-16 offset helpers for the shared wire contract.
//
// Contracts count a document as one flat string with global UTF-16 offsets
// (JS `string` indices). Ranges are half-open [start, end). Surrogate pairs
// (astral planes, e.g. emoji) occupy two units and must never be split.

/**
 * Return the UTF-16 length of a document string for wire offsets.
 *
 * Equivalent to `text.length`; surrogates count as two units by definition.
 */
export function utf16Length(text: string): number {
  return text.length;
}

/**
 * Check whether a UTF-16 unit is a high surrogate (lead half of a pair).
 *
 * Range `0xD800..0xDBFF`; pairs must never split across edit boundaries.
 */
function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

/**
 * Check whether a UTF-16 unit is a low surrogate (trail half of a pair).
 *
 * Range `0xDC00..0xDFFF`; validated together with the lead half.
 */
function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** True when `offset` does not split a surrogate pair in `text`. */
export function isBoundary(text: string, offset: number): boolean {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return false;
  if (offset === 0 || offset === text.length) return true;
  const prev = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  if (isHighSurrogate(prev) && isLowSurrogate(next)) return false;
  return true;
}

/**
 * Throw when `offset` is out of bounds or splits a surrogate pair.
 *
 * Guards every wire range entry so Rust never receives a split pair; messages
 * name the offending value for actionable notices.
 */
export function assertBoundary(text: string, offset: number, what: string): void {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) {
    throw new RangeError(`${what} is out of bounds: ${offset}`);
  }
  if (!isBoundary(text, offset)) {
    throw new RangeError(`${what} splits a surrogate pair: ${offset}`);
  }
}

export interface LineCol {
  /** 0-indexed line. */
  line: number;
  /** UTF-16 units from the line start (excludes the newline). */
  col: number;
}

/** Byte-agnostic line starts as UTF-16 offsets (line 0 always starts at 0). */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/**
 * Convert a global UTF-16 offset to 0-based line/column for status display.
 *
 * Asserts the offset boundary first; columns exclude the newline.
 */
export function offsetToLineCol(text: string, offset: number): LineCol {
  assertBoundary(text, offset, "offset");
  const starts = lineStarts(text);
  let line = 0;
  for (let i = 0; i < starts.length; i += 1) {
    if (starts[i] <= offset) line = i;
    else break;
  }
  return { line, col: offset - starts[line] };
}

/**
 * Convert a 0-based line/column to a global UTF-16 offset for jumps.
 *
 * Validates line/column bounds and the resulting boundary so outline and
 * search jumps never land inside a surrogate pair.
 */
export function lineColToOffset(text: string, line: number, col: number): number {
  const starts = lineStarts(text);
  if (!Number.isInteger(line) || line < 0 || line >= starts.length) {
    throw new RangeError(`line out of bounds: ${line}`);
  }
  const lineStart = starts[line];
  const lineEnd = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
  const offset = lineStart + col;
  if (!Number.isInteger(col) || col < 0 || offset > lineEnd) {
    throw new RangeError(`column out of bounds: line ${line} col ${col}`);
  }
  assertBoundary(text, offset, "offset");
  return offset;
}

export interface LineRange {
  start: number;
  /** Excludes the trailing newline. */
  end: number;
  line: string;
  lineIndex: number;
}

/** Global range of the line containing `offset` (newline excluded). */
export function lineRangeAt(text: string, offset: number): LineRange {
  assertBoundary(text, offset, "offset");
  const starts = lineStarts(text);
  let lineIndex = 0;
  for (let i = 0; i < starts.length; i += 1) {
    if (starts[i] <= offset) lineIndex = i;
    else break;
  }
  const start = starts[lineIndex];
  const end = lineIndex + 1 < starts.length ? starts[lineIndex + 1] - 1 : text.length;
  return { start, end, line: text.slice(start, end), lineIndex };
}

export interface TextEditLike {
  range: { start: number; end: number };
  text: string;
}

/**
 * Apply ascending, non-overlapping range edits tail-first without
 * reserializing the whole document by other means. Mirrors the Rust
 * `validate_edit` ordering rules for the browser fallback path.
 */
export function applyTextEdits(text: string, edits: TextEditLike[]): string {
  if (edits.length === 0) throw new RangeError("edits must not be empty");
  let prevStart = -1;
  let prevEnd = -1;
  for (const edit of edits) {
    const { start, end } = edit.range;
    if (!Number.isInteger(start) || !Number.isInteger(end)) throw new RangeError("range must be integers");
    if (start > end) throw new RangeError(`reversed range [${start}, ${end})`);
    if (start < 0 || end > text.length) throw new RangeError(`range [${start}, ${end}) out of bounds`);
    if (!isBoundary(text, start) || !isBoundary(text, end)) {
      throw new RangeError(`range [${start}, ${end}) splits a surrogate pair`);
    }
    // Equal starts (including multiple insertions at one offset) are rejected
    // to remove ordering ambiguity, matching validation.rs.
    if (start <= prevStart || start < prevEnd) {
      throw new RangeError(`overlapping edits at [${start}, ${end})`);
    }
    prevStart = start;
    prevEnd = end;
  }
  let out = text;
  for (let i = edits.length - 1; i >= 0; i -= 1) {
    const edit = edits[i];
    out = out.slice(0, edit.range.start) + edit.text + out.slice(edit.range.end);
  }
  return out;
}
