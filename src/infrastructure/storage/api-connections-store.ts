// Named API connection persistence in localStorage (infrastructure).
//
// Non-secret connection id/name/protocol/endpoint/model only. Secrets never
// touch this store: credentials live in the native OS store per connection
// ID. Loading never writes: only a missing key yields a migration-eligible
// empty list, while corrupt or unsupported data sanitizes to initialized so
// no silent legacy migration overwrites unknown bytes.

import { defaultConnectionList, isConnectionStorageCorrupted, sanitizeApiConnectionList, API_CONNECTIONS_STORAGE_KEY, type ApiConnectionList } from "../../domain/ai-connections";
import type { ApiConnectionStore } from "../../application/ports";

/**
 * Load the sanitized named-connection list, falling back to an empty list.
 *
 * A missing key means first run and stays migration-eligible; corrupt JSON,
 * blocked storage, or unsupported shapes sanitize to initialized so the
 * legacy single profile never migrates over unknown bytes. The legacy
 * single profile migrates separately and stays untouched.
 */
export function loadApiConnections(): ApiConnectionList {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(API_CONNECTIONS_STORAGE_KEY);
  } catch {
    return { ...defaultConnectionList(), initialized: true };
  }
  if (stored === null) return defaultConnectionList();
  try {
    return sanitizeApiConnectionList(JSON.parse(stored));
  } catch {
    return { ...defaultConnectionList(), initialized: true };
  }
}

/**
 * Persist a sanitized connection list, reporting quota/private-mode failures.
 *
 * Sanitizes before writing so stored JSON always validates on next load.
 * The single write is atomic: a throw leaves the previous bytes untouched,
 * and callers keep their prior state when this returns false.
 */
export function saveApiConnections(list: ApiConnectionList): boolean {
  try {
    window.localStorage.setItem(API_CONNECTIONS_STORAGE_KEY, JSON.stringify(sanitizeApiConnectionList(list)));
    return true;
  } catch {
    // Private mode / quota: report failure instead of silent drift.
    return false;
  }
}

/**
 * Inspect stored bytes without writing, reporting retention status.
 *
 * Missing keys report clean for one-shot migration; blocked reads, corrupt
 * JSON, and malformed/unsupported/duplicate payloads report corrupted so
 * callers retain the raw bytes and never silently overwrite them. Loading
 * itself never writes.
 */
export function inspectApiConnectionStorage(): { corrupted: boolean } {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(API_CONNECTIONS_STORAGE_KEY);
  } catch {
    return { corrupted: true };
  }
  if (stored === null) return { corrupted: false };
  try {
    return { corrupted: isConnectionStorageCorrupted(JSON.parse(stored)) };
  } catch {
    return { corrupted: true };
  }
}

/** Connection list store adapter satisfying the application port with localStorage. */
export const apiConnectionStore: ApiConnectionStore = {
  /** Load the sanitized connection list or an empty list. */
  load: loadApiConnections,
  /** Persist a sanitized connection list, reporting success. */
  save: saveApiConnections,
  /** Report whether stored bytes are present but unusable and must be retained. */
  inspect: inspectApiConnectionStorage,
};
