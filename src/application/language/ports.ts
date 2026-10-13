import type { LanguagePreference } from "../../contracts/language";

/** Persistence port for the selected UI language. */
export interface LanguagePreferenceStore {
  /** Read the stored preference or use system detection when absent. */
  load(): LanguagePreference;
  /** Persist a selected UI language preference. */
  save(preference: LanguagePreference): void;
}

/** Source of the host's primary display locale. */
export interface SystemLocaleSource {
  /** Read the locale reported by the embedding browser or WebView. */
  read(): string;
}
