import type { ThemeId } from "./workspace";

export interface EditorPreferences {
  theme: ThemeId;
  fontSize: number;
  lineHeight: number;
  wordWrap: boolean;
  lineNumbers: boolean;
  highlightActiveLine: boolean;
}

export const DEFAULT_EDITOR_PREFERENCES: EditorPreferences = {
  theme: "dark", fontSize: 15, lineHeight: 1.7,
  wordWrap: true, lineNumbers: true, highlightActiveLine: true,
};
const KEY = "marxen.editor-preferences.v1";

export function normalizeEditorPreferences(value: unknown): EditorPreferences {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const fallback = DEFAULT_EDITOR_PREFERENCES;
  const number = (key: string, min: number, max: number, defaultValue: number) =>
    typeof raw[key] === "number" && Number.isFinite(raw[key]) ? Math.min(max, Math.max(min, raw[key])) : defaultValue;
  const bool = (key: string, defaultValue: boolean) => typeof raw[key] === "boolean" ? raw[key] as boolean : defaultValue;
  return {
    theme: ["dark", "light", "contrast"].includes(raw.theme as string) ? raw.theme as ThemeId : fallback.theme,
    fontSize: Math.round(number("fontSize", 11, 28, fallback.fontSize)),
    lineHeight: number("lineHeight", 1.2, 2.4, fallback.lineHeight),
    wordWrap: bool("wordWrap", fallback.wordWrap),
    lineNumbers: bool("lineNumbers", fallback.lineNumbers),
    highlightActiveLine: bool("highlightActiveLine", fallback.highlightActiveLine),
  };
}

/** View preferences are non-secret; document and AI state remain native-owned. */
export function loadEditorPreferences(): EditorPreferences {
  try { return normalizeEditorPreferences(JSON.parse(localStorage.getItem(KEY) ?? "null")); }
  catch { return { ...DEFAULT_EDITOR_PREFERENCES }; }
}

export function saveEditorPreferences(preferences: EditorPreferences): boolean {
  try { localStorage.setItem(KEY, JSON.stringify(normalizeEditorPreferences(preferences))); return true; }
  catch { return false; }
}
