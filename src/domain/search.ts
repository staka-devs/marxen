import type { SearchOptions } from "../contracts/contracts";

/** Desktop defaults; all actual matching, including Unicode case folding, happens natively. */
export const DEFAULT_SEARCH_OPTIONS: SearchOptions = { caseSensitive: false, wholeWord: false, regex: false };

/** Stable lifecycle identity for a workspace query, independent of translated display text. */
export function searchIdentity(root: string | null, query: string, options: SearchOptions): string {
  return JSON.stringify([root, query, options.caseSensitive, options.wholeWord, options.regex]);
}
