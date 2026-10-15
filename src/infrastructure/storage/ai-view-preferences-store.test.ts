import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAiViewPreferencesStore } from "./ai-view-preferences-store";
import { defaultAiViewPreferences } from "../../domain/ai-view-preferences";

const aiViewPreferencesStore = createAiViewPreferencesStore();

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());
describe("AI view preference storage", () => {
  it("roundtrips selectors, providers, opaque models and width independently of connection state", () => {
    localStorage.setItem("marxen.ai-profile.v1", "retained-profile");
    localStorage.setItem("marxen.editor-preferences.v1", "retained-editor");
    const preferences = { ...defaultAiViewPreferences(), showProviderSelector: false, showModelSelector: false, hiddenProviders: ["opencode" as const], hiddenConnectionIds: ["api-hidden"], hiddenModels: [{ provider: "codex" as const, optionId: "agent.model", value: "actual/v2" }, { provider: "anthropic" as const, connectionId: "api-hidden", optionId: "model", value: "actual/v2" }], chatPaneWidth: 512 };
    expect(aiViewPreferencesStore.save(preferences)).toBe(true);
    expect(aiViewPreferencesStore.load()).toEqual(preferences);
    expect(createAiViewPreferencesStore().load()).toEqual(preferences);
    expect(localStorage.getItem("marxen.ai-profile.v1")).toBe("retained-profile");
    expect(localStorage.getItem("marxen.editor-preferences.v1")).toBe("retained-editor");
  });
  it("reads the existing v1 key with no connection visibility and retains legacy hides on save", () => {
    const legacy = { showProviderSelector: false, hiddenProviders: ["codex", "anthropic"], hiddenModels: [{ provider: "codex", optionId: "model", value: "actual" }], chatPaneWidth: 420 };
    localStorage.setItem("marxen.ai-view-preferences.v1", JSON.stringify(legacy));
    const restored = aiViewPreferencesStore.load();
    expect(restored).toMatchObject({ ...legacy, hiddenConnectionIds: [] });
    expect(aiViewPreferencesStore.save({ ...restored, hiddenConnectionIds: ["api-deleted", "api-deleted"] })).toBe(true);
    expect(createAiViewPreferencesStore().load()).toMatchObject({ ...legacy, hiddenConnectionIds: ["api-deleted"] });
  });
  it("recovers corrupt storage and reports rejected writes", () => {
    localStorage.setItem("marxen.ai-view-preferences.v1", "{broken");
    expect(aiViewPreferencesStore.load()).toEqual(defaultAiViewPreferences());
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(aiViewPreferencesStore.save(defaultAiViewPreferences())).toBe(false);
  });
});
