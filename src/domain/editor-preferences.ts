// Deterministic editor preferences model (domain).
//
// View-only theme/font/wrap settings. No Tauri, DOM, React, or browser
// globals: persistence lives in infrastructure storage and document/AI state
// stays native-owned.

import type { ThemeId } from "./workspace-content";

/** Supported viewport anchors for notifications outside the editor layout. */
export const NOTIFICATION_POSITIONS = ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"] as const;
/** Persisted notification anchor. */
export type NotificationPosition = typeof NOTIFICATION_POSITIONS[number];

/** View preferences for the CodeMirror editor chrome. */
export interface EditorPreferences {
  theme: ThemeId;
  fontSize: number;
  lineHeight: number;
  wordWrap: boolean;
  /** Show source line numbers in Markdown and split editors; live preview omits them. */
  lineNumbers: boolean;
  highlightActiveLine: boolean;
  notificationPosition: NotificationPosition;
}

/** First-run defaults: dark theme with readable Japanese typography. */
export const DEFAULT_EDITOR_PREFERENCES: EditorPreferences = {
  theme: "dark", fontSize: 15, lineHeight: 1.7,
  wordWrap: true, lineNumbers: true, highlightActiveLine: true,
  notificationPosition: "bottom-right",
};

/**
 * Normalize unknown stored JSON into valid preferences, clamping per field.
 *
 * Unknown themes reset to dark; font sizes round to 11..28; line heights
 * clamp to 1.2..2.4; non-boolean flags reset to defaults.
 */
export function normalizeEditorPreferences(value: unknown): EditorPreferences {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const fallback = DEFAULT_EDITOR_PREFERENCES;
  /** Clamp a numeric field into range or return its default. */
  const number = (key: string, min: number, max: number, defaultValue: number) =>
    typeof raw[key] === "number" && Number.isFinite(raw[key]) ? Math.min(max, Math.max(min, raw[key])) : defaultValue;
  /** Read a boolean field or return its default. */
  const bool = (key: string, defaultValue: boolean) => typeof raw[key] === "boolean" ? raw[key] as boolean : defaultValue;
  return {
    theme: ["dark", "light", "contrast"].includes(raw.theme as string) ? raw.theme as ThemeId : fallback.theme,
    fontSize: Math.round(number("fontSize", 11, 28, fallback.fontSize)),
    lineHeight: number("lineHeight", 1.2, 2.4, fallback.lineHeight),
    wordWrap: bool("wordWrap", fallback.wordWrap),
    lineNumbers: bool("lineNumbers", fallback.lineNumbers),
    highlightActiveLine: bool("highlightActiveLine", fallback.highlightActiveLine),
    notificationPosition: NOTIFICATION_POSITIONS.includes(raw.notificationPosition as NotificationPosition)
      ? raw.notificationPosition as NotificationPosition : fallback.notificationPosition,
  };
}
