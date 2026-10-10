// Editor preferences persistence in localStorage (infrastructure).
//
// View-only theme/font/wrap settings. Document and AI state remain
// native-owned; failures report false so the shell keeps changes for the
// session without pretending they persisted.

import { DEFAULT_EDITOR_PREFERENCES, normalizeEditorPreferences, type EditorPreferences } from "../../domain/editor-preferences";
import type { EditorPreferencesStore } from "../../application/ports";

/** Storage key versioning the preferences shape. */
const KEY = "marxen.editor-preferences.v1";

/**
 * Load normalized editor preferences, falling back to dark defaults.
 *
 * Corrupt JSON or missing storage returns a copy of the defaults.
 */
export function loadEditorPreferences(): EditorPreferences {
  try { return normalizeEditorPreferences(JSON.parse(localStorage.getItem(KEY) ?? "null")); }
  catch { return { ...DEFAULT_EDITOR_PREFERENCES }; }
}

/**
 * Persist normalized preferences, reporting whether the write succeeded.
 *
 * Returns false in private mode/quota so the shell can notice once.
 */
export function saveEditorPreferences(preferences: EditorPreferences): boolean {
  try { localStorage.setItem(KEY, JSON.stringify(normalizeEditorPreferences(preferences))); return true; }
  catch { return false; }
}


/** Editor preferences store adapter satisfying the application port. */
export const editorPreferencesStore: EditorPreferencesStore = {
  /** Load normalized preferences or defaults. */
  load: loadEditorPreferences,
  /** Persist normalized preferences, reporting success. */
  save: saveEditorPreferences,
};

