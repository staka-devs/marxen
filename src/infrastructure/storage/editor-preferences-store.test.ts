import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_EDITOR_PREFERENCES, NOTIFICATION_POSITIONS, normalizeEditorPreferences } from "../../domain/editor-preferences";
import { loadEditorPreferences, saveEditorPreferences } from "./editor-preferences-store";

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

it("persists the hard-break toggle while preserving notification preferences and old defaults", () => {
  const changed = { ...DEFAULT_EDITOR_PREFERENCES, hardBreakOnEnter: true, notificationPosition: "top-left" as const };
  expect(saveEditorPreferences(changed)).toBe(true);
  expect(loadEditorPreferences()).toEqual(changed);
  const { hardBreakOnEnter: _flag, ...old } = changed;
  localStorage.setItem("marxen.editor-preferences.v1", JSON.stringify(old));
  expect(loadEditorPreferences()).toEqual({ ...changed, hardBreakOnEnter: false });
});

it("restores view preferences without losing disabled values", () => {
  const changed = { ...DEFAULT_EDITOR_PREFERENCES, theme: "light" as const, fontSize: 20, lineHeight: 2, wordWrap: false, lineNumbers: false };
  expect(saveEditorPreferences(changed)).toBe(true);
  expect(loadEditorPreferences()).toEqual(changed);
});

it.each(NOTIFICATION_POSITIONS)("round-trips the persisted %s notification anchor", (notificationPosition) => {
  const changed = { ...DEFAULT_EDITOR_PREFERENCES, fontSize: 19, notificationPosition };
  expect(saveEditorPreferences(changed)).toBe(true);
  expect(loadEditorPreferences()).toEqual(changed);
});

it.each([undefined, null, "top", "TOP-LEFT", "", 3, {}, ["top-left"]])("defaults invalid notification anchors %j to bottom-right", (notificationPosition) => {
  expect(normalizeEditorPreferences({ fontSize: 17, notificationPosition })).toEqual({ ...DEFAULT_EDITOR_PREFERENCES, fontSize: 17 });
});

it("migrates old preferences and normalizes before persistence", () => {
  const { notificationPosition: _position, ...legacy } = DEFAULT_EDITOR_PREFERENCES;
  localStorage.setItem("marxen.editor-preferences.v1", JSON.stringify({ ...legacy, theme: "light" }));
  expect(loadEditorPreferences()).toEqual({ ...DEFAULT_EDITOR_PREFERENCES, theme: "light" });
  expect(saveEditorPreferences({ ...DEFAULT_EDITOR_PREFERENCES, notificationPosition: "unknown" as "bottom-right" })).toBe(true);
  expect(loadEditorPreferences().notificationPosition).toBe("bottom-right");
});

it("reports blocked persistence and recovers unavailable storage", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  expect(saveEditorPreferences({ ...DEFAULT_EDITOR_PREFERENCES, notificationPosition: "top-left" })).toBe(false);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(loadEditorPreferences()).toEqual(DEFAULT_EDITOR_PREFERENCES);
});

it("bounds corrupt values and recovers malformed stored JSON", () => {
  expect(normalizeEditorPreferences({ fontSize: 1000, lineHeight: -5, theme: "unknown", wordWrap: "false" })).toEqual({ ...DEFAULT_EDITOR_PREFERENCES, fontSize: 28, lineHeight: 1.2 });
  localStorage.setItem("marxen.editor-preferences.v1", "{");
  expect(loadEditorPreferences()).toEqual(DEFAULT_EDITOR_PREFERENCES);
});
