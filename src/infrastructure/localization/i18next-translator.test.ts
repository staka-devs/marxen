import { describe, expect, it } from "vitest";
import { createTranslator } from "./i18next-translator";
import { englishMessages, japaneseMessages, regionalMessages } from "../../contracts/localization-messages";
import { intlLocale, normalizeLanguagePreference, resolveLanguage } from "../../domain/language";
import { workspaceErrorText } from "../../domain/document-errors";
import { describeAiError } from "../../domain/ai-config";
import { languagePreferenceStore } from "../storage/language-preference-store";
import { createLanguageService } from "../../application/language/language-service";
import type { Language } from "../../contracts/language";
import { LocalizedError } from "../../domain/localized-error";

/** Return each named interpolation slot exactly once for catalog comparison. */
function parameters(template: string): string[] {
  return [...new Set([...template.matchAll(/\{\{([^}]+)\}\}/g)].map(match => match[1]))].sort();
}

describe("localization contracts", () => {
  it("covers every base key and interpolation slot, with regional fallback", () => {
    expect(Object.keys(englishMessages).sort()).toEqual(Object.keys(japaneseMessages).sort());
    const translators = (["en-US", "ja-JP", "ja-JP-x-kansai", "ja-JP-x-tokushima"] as Language[]).map(language => ({ language, t: createTranslator(language) as (key: string, values?: Record<string, string | number>) => string }));
    for (const [key, template] of Object.entries(japaneseMessages)) {
      expect(template.trim(), key).not.toBe("");
      expect(englishMessages[key as keyof typeof englishMessages].trim(), key).not.toBe("");
      expect(parameters(englishMessages[key as keyof typeof englishMessages]), key).toEqual(parameters(template));
      for (const { language, t } of translators) {
        const values = Object.fromEntries(parameters(template).map(name => [name, name === "count" ? 1234 : `<${name}>`]));
        const rendered = t(key, values);
        expect(rendered, `${language}: ${key}`).not.toContain("{{");
        for (const value of Object.values(values)) expect(rendered).toContain(typeof value === "number" ? new Intl.NumberFormat(intlLocale(language)).format(value) : value);
      }
    }
    for (const overlay of Object.values(regionalMessages)) for (const key of Object.keys(overlay)) expect(key in japaneseMessages).toBe(true);
    expect(createTranslator("ja-JP-x-tokushima")("設定")).toBe("設定");
    expect(createTranslator("ja-JP-x-tokushima")("保存しました。")).toBe("保存できたで。");
  });

  it("checks required parameters, English plurals and basic-locale Intl formatting", () => {
    const t = createTranslator("en-US");
    expect(t("{{count}} 件", { count: 1 })).toBe("1 match");
    expect(t("{{count}} 件", { count: 2 })).toBe("2 matches");
    expect(t("{{count}} 件", { count: 1234 })).toBe("1,234 matches");
    expect(t("{{value0}}をコピーしました。", { value0: "/日本語/保存.md" })).toBe("Copied /日本語/保存.md.");
    expect(() => (t as (key: string) => string)("{{value0}}をコピーしました。")).toThrow("Missing localization parameter");
    for (const language of ["ja-JP-x-kansai", "ja-JP-x-tokushima"] as Language[]) {
      expect(() => new Intl.DateTimeFormat(intlLocale(language)).format(0)).not.toThrow();
      expect(() => new Intl.NumberFormat(intlLocale(language)).format(1234)).not.toThrow();
    }
    if (false) {
      // @ts-expect-error Translation keys must exist in the base catalog.
      t("missing.key");
      // @ts-expect-error Every interpolation slot is required.
      t("{{value0}}をコピーしました。");
      // @ts-expect-error Additional interpolation names are rejected.
      t("{{value0}}をコピーしました。", { value0: "x", extra: "y" });
    }
  });

  it("persists explicit choices across service recreation and only auto-selects standard Japanese", () => {
    localStorage.removeItem("marxen.language");
    const first = createLanguageService(languagePreferenceStore);
    expect(first.load("ja-JP-x-tokushima").language).toBe("ja-JP");
    first.select("ja-JP-x-tokushima", "en-US");
    expect(createLanguageService(languagePreferenceStore).load("en-US").language).toBe("ja-JP-x-tokushima");
    expect(resolveLanguage("system", "en-GB")).toBe("en-US");
    expect(normalizeLanguagePreference("ja-JP-x-unrecognized")).toBe("ja-JP");
    expect(normalizeLanguagePreference("invalid locale!")).toBe("system");
    localStorage.removeItem("marxen.language");
  });

  it("localizes structured error explanations and preserves backend detail text", () => {
    const t = createTranslator("en-US");
    expect(workspaceErrorText({ code: "io", detail: "詳細 /日本語/a.md" }, t)).toBe("I/O error: 詳細 /日本語/a.md");
    expect(workspaceErrorText(new Error("Rust detail retained"), t)).toBe("Rust detail retained");
    expect(workspaceErrorText(new LocalizedError("コピー画像の変換に失敗しました。"), t)).toBe("Unable to convert the copied image.");
    expect(describeAiError({ code: "connection_failed", detail: "HTTP 403: 詳細" }, t)).toBe("Unable to connect: HTTP 403: 詳細");
  });
});
