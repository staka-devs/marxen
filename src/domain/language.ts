import type { Language, LanguagePreference } from "../contracts/language";

/** Select the app language from a stored preference and operating-system locale. */
export function resolveLanguage(preference: LanguagePreference, systemLocale: string): Language {
  if (preference !== "system") return preference;
  return systemLocale.toLowerCase().startsWith("ja") ? "ja-JP" : "en-US";
}

/** Normalize stored tags, falling back from unknown Japanese variants to standard Japanese. */
export function normalizeLanguagePreference(value: unknown): LanguagePreference {
  if (value === "system" || value === "en-US" || value === "ja-JP" || value === "ja-JP-x-kansai" || value === "ja-JP-x-tokushima") return value;
  return typeof value === "string" && /^ja(?:-|$)/i.test(value) ? "ja-JP" : "system";
}

/** Return the valid Intl locale for app formatting, stripping unsupported private extensions. */
export function intlLocale(language: Language): "en-US" | "ja-JP" {
  return language === "en-US" ? "en-US" : "ja-JP";
}
