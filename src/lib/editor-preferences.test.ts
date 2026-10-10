import { afterEach, expect, it } from "vitest";
import { DEFAULT_EDITOR_PREFERENCES, loadEditorPreferences, normalizeEditorPreferences, saveEditorPreferences } from "./editor-preferences";

afterEach(() => localStorage.clear());

it("restores view preferences without losing disabled values", () => {
  const changed = { ...DEFAULT_EDITOR_PREFERENCES, theme: "light" as const, fontSize: 20, lineHeight: 2, wordWrap: false, lineNumbers: false };
  expect(saveEditorPreferences(changed)).toBe(true);
  expect(loadEditorPreferences()).toEqual(changed);
});

it("bounds corrupt values and recovers malformed stored JSON", () => {
  expect(normalizeEditorPreferences({ fontSize: 1000, lineHeight: -5, theme: "unknown", wordWrap: "false" })).toEqual({ ...DEFAULT_EDITOR_PREFERENCES, fontSize: 28, lineHeight: 1.2 });
  localStorage.setItem("marxen.editor-preferences.v1", "{");
  expect(loadEditorPreferences()).toEqual(DEFAULT_EDITOR_PREFERENCES);
});
