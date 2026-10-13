// Document view helpers for the shell (application).
//
// Pure adapters between wire snapshots and the shell's open-document view.
// No Tauri, DOM, React, or browser globals: revision checks are newer-or-equal
// so late completions never rewind the view.

import type {
  DocumentSnapshot,
  OpenDocument,
  SearchMatch,
} from "../../contracts/contracts";
import type { SearchHitItem } from "../../domain/search-hit";

/** Shell open-document view derived from a wire snapshot. */
export interface OpenDoc {
  documentId: string;
  path: string | null;
  text: string;
  revision: number;
  dirty: boolean;
}

/**
 * Adapt a wire `OpenDocument` to the shell view.
 *
 * Copies snapshot fields verbatim; the registry stays authoritative.
 */
export function docFromOpen(open: OpenDocument): OpenDoc {
  return {
    documentId: open.snapshot.documentId,
    path: open.path,
    text: open.snapshot.text,
    revision: open.snapshot.revision,
    dirty: open.snapshot.dirty,
  };
}

/**
 * Replace a document view with a newer-or-equal snapshot.
 *
 * Spreads the previous view so UI-only fields survive the merge.
 */
export function applySnapshot(doc: OpenDoc, snapshot: DocumentSnapshot): OpenDoc {
  return { ...doc, text: snapshot.text, revision: snapshot.revision, dirty: snapshot.dirty };
}

/**
 * Display label for a path, falling back when untitled.
 *
 * Uses the final segment; empty basenames keep the full path.
 */
export function fileLabel(path: string | null, fallback: string): string {
  if (!path) return fallback;
  const base = path.split("/").pop() ?? path;
  return base === "" ? path : base;
}

/**
 * Adapt a wire search match to a panel hit with UTF-16 offsets.
 *
 * Columns reset to 0; offsets carry the exact range for jumps and replace.
 */
export function matchToHit(match: SearchMatch): SearchHitItem {
  return {
    path: match.path,
    line: match.line,
    col: 0,
    preview: match.preview,
    documentId: match.documentId,
    revision: match.revision,
    offset: match.range.start,
    end: match.range.end,
  };
}

/**
 * Check whether two prompt context lists describe the exact same scope.
 *
 * Compares IDs, revisions, full text, and every range so staging reuses the
 * copy only on exact match and re-registers otherwise.
 */
export function contextsEqual(
  left: Array<{ documentId: string; revision: number; text: string; ranges: Array<{ start: number; end: number }> }>,
  right: Array<{ documentId: string; revision: number; text: string; ranges: Array<{ start: number; end: number }> }>,
): boolean {
  if (left.length !== right.length) return false;
  return left.every((context, index) => {
    const other = right[index];
    return (
      context.documentId === other.documentId &&
      context.revision === other.revision &&
      context.text === other.text &&
      context.ranges.length === other.ranges.length &&
      context.ranges.every((range, rangeIndex) => {
        const o = other.ranges[rangeIndex];
        return range.start === o.start && range.end === o.end;
      })
    );
  });
}
