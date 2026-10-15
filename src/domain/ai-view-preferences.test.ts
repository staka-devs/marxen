import { describe, expect, it } from "vitest";
import { clampAiChatWidth, defaultAiViewPreferences, isAiModelVisible, normalizeAiViewPreferences, setAiModelVisible, setAiProviderVisible } from "./ai-view-preferences";

describe("AI view preference rules", () => {
  it("keeps visibility scoped by provider, option ID and actual value", () => {
    const original = defaultAiViewPreferences();
    const hidden = setAiModelVisible(setAiProviderVisible(original, "codex", false), { provider: "codex", optionId: "actual.model", value: "reported-id" }, false);
    expect(isAiModelVisible(hidden, "codex", "actual.model", "reported-id")).toBe(false);
    expect(isAiModelVisible(hidden, "opencode", "actual.model", "reported-id")).toBe(true);
    expect(isAiModelVisible(hidden, "codex", "other.option", "reported-id")).toBe(true);
    expect(original).toEqual(defaultAiViewPreferences());
    expect(setAiModelVisible(hidden, { provider: "codex", optionId: "actual.model", value: "reported-id" }, true).hiddenModels).toEqual([]);
  });
  it("sanitizes corrupt data and duplicates without adding model IDs", () => {
    expect(normalizeAiViewPreferences(null)).toEqual(defaultAiViewPreferences());
    const model = { provider: "codex", optionId: "catalog/model", value: "opaque/id" };
    const result = normalizeAiViewPreferences({ hiddenProviders: ["codex", "unknown", "codex"], hiddenModels: [null, model, model, { ...model, provider: "invented" }], chatPaneWidth: 9999, showModelSelector: false, showProviderSelector: "no" });
    expect(result.hiddenModels).toEqual([model]);
    expect(result.hiddenProviders).toEqual(["codex"]);
    expect(result.chatPaneWidth).toBe(720);
    expect(result.showProviderSelector).toBe(true);
    expect(result.showModelSelector).toBe(false);
  });
  it("clamps wide, narrow and invalid widths without exceeding available space", () => {
    expect(clampAiChatWidth(100)).toBe(280);
    expect(clampAiChatWidth(900)).toBe(720);
    expect(clampAiChatWidth(NaN)).toBe(360);
    expect(clampAiChatWidth(720, 800)).toBe(560);
    expect(clampAiChatWidth(720, 320)).toBe(320);
    expect(clampAiChatWidth(720, 200)).toBe(200);
    expect(clampAiChatWidth(400, -10)).toBe(0);
  });
  it("separates named-connection model visibility by stable ID without touching kind entries", () => {
    const scoped = { provider: "openai_compatible" as const, optionId: "model", value: "model-a" };
    const hidden = setAiModelVisible(defaultAiViewPreferences(), { ...scoped, connectionId: "api-1" }, false);
    expect(isAiModelVisible(hidden, "openai_compatible", "model", "model-a", "api-1")).toBe(false);
    expect(isAiModelVisible(hidden, "openai_compatible", "model", "model-a", "api-2")).toBe(true);
    expect(isAiModelVisible(hidden, "openai_compatible", "model", "model-a")).toBe(true);
    const kindHidden = setAiModelVisible(defaultAiViewPreferences(), scoped, false);
    expect(isAiModelVisible(kindHidden, "openai_compatible", "model", "model-a")).toBe(false);
    expect(isAiModelVisible(kindHidden, "openai_compatible", "model", "model-a", "api-1")).toBe(true);
    expect(setAiModelVisible(hidden, { ...scoped, connectionId: "api-1" }, true).hiddenModels).toEqual([]);
    const normalized = normalizeAiViewPreferences({ hiddenModels: [{ ...scoped, connectionId: "api-1" }, { ...scoped, connectionId: "bad id" }, { ...scoped, connectionId: 7 }] });
    expect(normalized.hiddenModels).toEqual([{ ...scoped, connectionId: "api-1" }]);
  });
});
