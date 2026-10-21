import type { SearchOptions } from "../contracts/contracts";

/** Desktop defaults; all actual matching, including Unicode case folding, happens natively. */
export const DEFAULT_SEARCH_OPTIONS: SearchOptions = { caseSensitive: false, wholeWord: false, regex: false };

/** Vim `:s` patterns are case-sensitive Vim regexes, matching the native search semantics. */
export const SUBSTITUTE_SEARCH_OPTIONS: SearchOptions = { caseSensitive: true, wholeWord: false, regex: true };

/** Ex range, `:s` and its abbreviations up to `:substitute`, then the delimiter. */
const SUBSTITUTE_HEAD = /^:[\s:]*(?:%|[.$\d,;+\-\s]|'[a-zA-Z<>])*s(?:u(?:b(?:s(?:t(?:i(?:t(?:u(?:te?)?)?)?)?)?)?)?)?([^\w\s"|\\])/;

/**
 * Read the pattern and replacement from a typed `:s/pat/rep/flags` command line.
 *
 * Returns null for other commands and for the empty pattern (Vim's "last search").
 */
export function parseSubstituteCommand(text: string): { pattern: string; replacement: string } | null {
  const head = SUBSTITUTE_HEAD.exec(text);
  if (!head) return null;
  const delimiter = head[1];
  const parts = [""];
  for (let index = head[0].length; index < text.length && parts.length <= 2; index += 1) {
    const char = text[index];
    if (char === "\\" && text[index + 1] === delimiter) { parts[parts.length - 1] += delimiter; index += 1; }
    else if (char === "\\" && index + 1 < text.length) { parts[parts.length - 1] += char + text[index + 1]; index += 1; }
    else if (char === delimiter) parts.push("");
    else parts[parts.length - 1] += char;
  }
  return parts[0] === "" ? null : { pattern: parts[0], replacement: parts[1] ?? "" };
}

/** Stable lifecycle identity for a workspace query, independent of translated display text. */
export function searchIdentity(root: string | null, query: string, options: SearchOptions): string {
  return JSON.stringify([root, query, options.caseSensitive, options.wholeWord, options.regex]);
}
