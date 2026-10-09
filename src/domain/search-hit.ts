// Search hit item shared by search use cases and the panel (domain).
//
// Global UTF-16 offsets for jumps and replace; registry matches carry
// document ID and revision, local demo hits leave them null.

/** Panel hit with exact UTF-16 offsets for jump and replace. */
export interface SearchHitItem {
  path: string;
  line: number;
  col: number;
  preview: string;
  documentId?: string | null;
  revision?: number | null;
  /** Global UTF-16 offset of the match start (registry matches). */
  offset?: number;
  /** Global UTF-16 offset of the match end. */
  end?: number;
}
