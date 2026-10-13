import type { Language, LanguagePreference } from "../../contracts/language";
import { resolveLanguage } from "../../domain/language";
import type { LanguagePreferenceStore } from "./ports";

/** Application use cases for resolving and persisting the active language. */
export function createLanguageService(store: LanguagePreferenceStore) {
  /** Resolve the effective UI language from persisted preference and system locale. */
  function load(systemLocale: string): { preference: LanguagePreference; language: Language } {
    const preference = store.load();
    return { preference, language: resolveLanguage(preference, systemLocale) };
  }
  /** Save a user-selected language and resolve its effective locale immediately. */
  function select(preference: LanguagePreference, systemLocale: string): Language {
    store.save(preference);
    return resolveLanguage(preference, systemLocale);
  }
  return { load, select };
}
