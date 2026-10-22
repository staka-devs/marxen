// Line diff between an AI change's original text and the current text (domain).
//
// Shared prefix/suffix lines are trimmed first, then an exact LCS runs on the
// changed middle. AI edits are local, so the middle stays small; past the cap
// the whole middle is reported as replaced instead of spending quadratic time.

/** Lines inserted at a current-text line, and original lines removed just before it. */
export interface LineChange {
  /** Zero-based line in the current text where the change starts. */
  line: number;
  /** Number of current lines added or changed from `line`. */
  added: number;
  /** Original lines removed before `line`, shown as struck-through context. */
  removed: string[];
}

/** Middle sizes beyond this product skip LCS and report one replaced block. */
const MAX_CELLS = 4_000_000;

/** Group the line differences between `before` and `after` into display hunks. */
export function lineChanges(before: string, after: string): LineChange[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length === 0 && midB.length === 0) return [];
  if (midA.length * midB.length > MAX_CELLS) return [{ line: start, added: midB.length, removed: midA }];
  // lcs[i][j]: common length of midA[i..] and midB[j..].
  const lcs = Array.from({ length: midA.length + 1 }, () => new Uint32Array(midB.length + 1));
  for (let i = midA.length - 1; i >= 0; i -= 1) {
    for (let j = midB.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const changes: LineChange[] = [];
  let current: LineChange | null = null;
  let i = 0;
  let j = 0;
  /** Start or extend the hunk at current line `start + j`. */
  const hunk = () => (current ??= { line: start + j, added: 0, removed: [] });
  while (i < midA.length || j < midB.length) {
    if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
      if (current) changes.push(current);
      current = null;
      i += 1;
      j += 1;
    } else if (j < midB.length && (i === midA.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      hunk().added += 1;
      j += 1;
    } else {
      hunk().removed.push(midA[i]);
      i += 1;
    }
  }
  if (current) changes.push(current);
  return changes;
}
