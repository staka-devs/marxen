// Multi-root identity helpers (domain).
//
// Pure rootId plus relative-path identification for trees, quick-open,
// search, images, and tabs. No Tauri, DOM, React, or browser globals: all
// inputs are plain strings so the same rules run in tests and the shell.

import type { RootScope } from "../contracts/contracts";

/** Leaf file with its owning root incarnation. */
export interface RootFile {
  scope: RootScope;
  root: string;
  path: string;
}

/**
 * Build a stable tab key from owning root and relative path.
 *
 * Document tabs keep their authoritative document ID; image tabs use this
 * key so the same filename in another root never reuses bytes.
 */
export function imageTabId(rootId: string, path: string): string {
  return `image:${rootId}:${path}`;
}

/**
 * Parse an image tab ID back to its owning root and relative path.
 *
 * Returns null for legacy single-root `image:path` IDs so old tabs keep
 * working without guessing a new owner.
 */
export function parseImageTabId(id: string): { rootId: string | null; path: string } | null {
  if (!id.startsWith("image:")) return null;
  const rest = id.slice("image:".length);
  const at = rest.indexOf(":");
  if (at < 0) return { rootId: null, path: rest };
  return { rootId: rest.slice(0, at), path: rest.slice(at + 1) };
}

/**
 * Build a stable search group key from owning root and relative path.
 *
 * Same relative names in different roots stay separate; legacy hits without
 * scope keep their path-only key.
 */
export function searchGroupKey(scope: RootScope | undefined, path: string): string {
  if (!scope) return `path:${path}`;
  return `${scope.rootId}::${scope.generation}::${path}`;
}

/**
 * Build a display label for a root-qualified file.
 *
 * Shows the root folder name plus relative path so identical filenames are
 * distinguishable in quick-open, tabs, and search.
 */
export function rootFileLabel(root: string, path: string): string {
  const base = root.split(/[\\/]/).filter(Boolean).at(-1) ?? root;
  return `${base}/${path}`;
}
