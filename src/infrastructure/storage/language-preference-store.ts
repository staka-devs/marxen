import type { LanguagePreference } from "../../contracts/language";
import type { LanguagePreferenceStore } from "../../application/language/ports";
import { normalizeLanguagePreference } from "../../domain/language";

const STORAGE_KEY = "marxen.language";

/** Load and validate the language preference from browser storage. */
function loadLanguagePreference(): LanguagePreference {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY);
    return normalizeLanguagePreference(value);
  } catch {
    return "system";
  }
}

/** Persist the language preference while tolerating unavailable browser storage. */
function saveLanguagePreference(preference: LanguagePreference): void {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, preference); } catch { /* Storage can be disabled by the host. */ }
}

/** Browser-backed language preference adapter. */
export const languagePreferenceStore: LanguagePreferenceStore = {
  load: loadLanguagePreference,
  save: saveLanguagePreference,
};
