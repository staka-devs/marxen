// Workspace roots metadata persistence in localStorage (infrastructure).
//
// Versioned roots, tabs, and selection for multi-root restore. Missing roots
// and legacy unsaved recovery are retained, never deleted here; the shell
// re-adds reachable roots and keeps unreachable entries visible as missing.

import type { WorkspaceMetadata, PersistedRoot, PersistedTab } from "../../contracts/workspace-metadata";
import type { WorkspaceMetadataStore } from "../../application/ports";

/** Storage key versioning the metadata shape. */
const KEY = "marxen.workspace-metadata.v1";

/**
 * Normalize unknown persisted bytes to versioned metadata.
 *
 * Unknown versions, corrupt JSON, or missing storage fall back to empty
 * roots and tabs; legacy single-root strings are accepted as one root.
 */
export function normalizeWorkspaceMetadata(value: unknown): WorkspaceMetadata {
  const fallback: WorkspaceMetadata = { version: 1, roots: [], tabs: [], active: null };
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return fallback;
    return { version: 1, roots: [{ root: trimmed }], tabs: [], active: null };
  }
  if (typeof value !== "object") return fallback;
  const record = value as { version?: unknown; roots?: unknown; tabs?: unknown; active?: unknown };
  if (record.version !== 1 && record.version !== undefined) return fallback;
  const roots: PersistedRoot[] = [];
  if (Array.isArray(record.roots)) {
    for (const entry of record.roots) {
      if (typeof entry === "string" && entry.trim() !== "") roots.push({ root: entry });
      else if (entry !== null && typeof entry === "object" && typeof (entry as { root?: unknown }).root === "string" && ((entry as { root: string }).root.trim() !== "")) {
        roots.push({ root: (entry as { root: string }).root });
      }
    }
  }
  const tabs: PersistedTab[] = [];
  if (Array.isArray(record.tabs)) {
    for (const entry of record.tabs) {
      if (entry !== null && typeof entry === "object") {
        const tab = entry as { root?: unknown; path?: unknown; image?: unknown };
        if (typeof tab.root === "string" && typeof tab.path === "string" && tab.root !== "" && tab.path !== "") {
          const selection = (entry as { selection?: { anchor?: unknown; head?: unknown } }).selection;
          tabs.push({ root: tab.root, path: tab.path, image: tab.image === true, ...(selection && Number.isInteger(selection.anchor) && Number.isInteger(selection.head) && Number(selection.anchor) >= 0 && Number(selection.head) >= 0 ? { selection: { anchor: Number(selection.anchor), head: Number(selection.head) } } : {}) });
        }
      }
    }
  }
  let active: PersistedTab | null = null;
  if (record.active !== null && typeof record.active === "object") {
    const tab = record.active as { root?: unknown; path?: unknown; image?: unknown };
    if (typeof tab.root === "string" && typeof tab.path === "string" && tab.root !== "" && tab.path !== "") {
      active = { root: tab.root, path: tab.path, image: tab.image === true };
    }
  }
  const seen = new Set<string>();
  const dedupedRoots = roots.filter((entry) => {
    if (seen.has(entry.root)) return false;
    seen.add(entry.root);
    return true;
  });
  const dedupedTabs = [...new Map(tabs.map((tab) => [JSON.stringify([tab.root, tab.path, tab.image]), tab])).values()];
  return { version: 1, roots: dedupedRoots, tabs: dedupedTabs, active };
}

/**
 * Load versioned workspace metadata, retaining unreachable entries.
 *
 * Corrupt JSON returns empty metadata without deleting stored bytes.
 */
export function loadWorkspaceMetadata(): WorkspaceMetadata {
  try {
    return normalizeWorkspaceMetadata(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return { version: 1, roots: [], tabs: [], active: null };
  }
}

/**
 * Persist versioned workspace metadata, reporting whether the write succeeded.
 *
 * Returns false in private mode/quota so the shell keeps session state.
 */
export function saveWorkspaceMetadata(metadata: WorkspaceMetadata): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(normalizeWorkspaceMetadata(metadata)));
    return true;
  } catch {
    return false;
  }
}

/** Preserve corrupt and unsupported stored layouts until the user can recover them. */
export const workspaceMetadataStore: WorkspaceMetadataStore = {
  /** Load only recognized versions without rewriting unknown bytes. */
  load() {
    try {
      const raw = localStorage.getItem(KEY);
      const value: unknown = raw === null ? null : JSON.parse(raw);
      if (value !== null && typeof value !== "string" && (typeof value !== "object" || Array.isArray(value) || !("version" in value) || value.version !== 1 || !("roots" in value) || !Array.isArray(value.roots) || !("tabs" in value) || !Array.isArray(value.tabs))) return null;
      return normalizeWorkspaceMetadata(value);
    } catch { return null; }
  },
  save: saveWorkspaceMetadata,
};
