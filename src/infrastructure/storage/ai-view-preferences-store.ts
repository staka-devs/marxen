import type { AiViewPreferencesStore } from "../../application/ai/view-preferences-port";
import type { AiViewPreferences } from "../../contracts/ai-view-preferences";
import { defaultAiViewPreferences, normalizeAiViewPreferences } from "../../domain/ai-view-preferences";

const KEY = "marxen.ai-view-preferences.v1";

/** Load only AI presentation preferences, tolerating missing, corrupt or unavailable storage. */
export function loadAiViewPreferences(): AiViewPreferences {
  try { return normalizeAiViewPreferences(JSON.parse(localStorage.getItem(KEY) ?? "null")); }
  catch { return defaultAiViewPreferences(); }
}

/** Persist validated AI view state without storing connection, credentials or document contents. */
export function saveAiViewPreferences(preferences: AiViewPreferences): boolean {
  try { localStorage.setItem(KEY, JSON.stringify(normalizeAiViewPreferences(preferences))); return true; }
  catch { return false; }
}

/** Create the view-only adapter once in composition for shared chat, pane and settings state. */
export function createAiViewPreferencesStore(): AiViewPreferencesStore {
  return { load: loadAiViewPreferences, save: saveAiViewPreferences };
}
