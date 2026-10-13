/** Language identifiers supported by the presentation. */
export type Language = "en-US" | "ja-JP" | "ja-JP-x-kansai" | "ja-JP-x-tokushima";

/** Persisted language preference; null means detect the operating system locale. */
export type LanguagePreference = Language | "system";
