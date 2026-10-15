/** Root paths survive restart; native incarnations are reissued when opened. */
export interface PersistedRoot { root: string }

/** Tab ownership and UTF-16 selection, without duplicating authoritative text. */
export interface PersistedTab {
  root: string;
  path: string;
  image: boolean;
  selection?: { anchor: number; head: number };
}

/** Versioned workspace layout; unavailable roots and tabs remain recoverable. */
export interface WorkspaceMetadata {
  version: 1;
  roots: PersistedRoot[];
  tabs: PersistedTab[];
  active: PersistedTab | null;
}
