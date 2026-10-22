import { describe, expect, it } from "vitest";
import { Contrast, Hct, argbFromHex } from "@material/material-color-utilities";
import { DEFAULT_SEED_COLOR, schemeStylesheet, schemeTokens, textOn } from "./color-scheme";
import { MATERIAL_HUES, MATERIAL_SHADES, findMaterialColor } from "./material-palette";
import { normalizeEditorPreferences } from "./editor-preferences";

/** WCAG contrast ratio between two hex colors via Material tones. */
const ratio = (a: string, b: string) => Contrast.ratioOfTones(Hct.fromInt(argbFromHex(a)).tone, Hct.fromInt(argbFromHex(b)).tone);

describe("Material palette", () => {
  it("has 19 hues with 14 shades, except 10 for brown, grey and blue grey", () => {
    expect(MATERIAL_HUES).toHaveLength(19);
    for (const hue of MATERIAL_HUES) {
      expect(hue.colors).toHaveLength(["brown", "grey", "blue-grey"].includes(hue.id) ? 10 : MATERIAL_SHADES.length);
      for (const color of hue.colors) expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(findMaterialColor("#1976D2")).toMatchObject({ hue: { id: "blue" }, shade: 7 });
    expect(findMaterialColor("#123456")).toBeNull();
  });
});

describe("Material 3 scheme", () => {
  it("keeps text and accent readable for every palette seed in light and dark", () => {
    for (const color of MATERIAL_HUES.flatMap((hue) => hue.colors)) {
      for (const tokens of Object.values(schemeTokens(color))) {
        expect(ratio(tokens["--foreground"], tokens["--background"])).toBeGreaterThanOrEqual(7);
        expect(ratio(tokens["--muted-foreground"], tokens["--background"])).toBeGreaterThanOrEqual(4.5);
        expect(ratio(tokens["--primary-foreground"], tokens["--primary"])).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps the seed's vividness: an accent shade yields a more chromatic primary than a pale one", () => {
    /** Chroma of the generated light primary for one seed. */
    const chroma = (seed: string) => Hct.fromInt(argbFromHex(schemeTokens(seed).light["--primary"])).chroma;
    expect(chroma("#2979ff")).toBeGreaterThan(chroma("#e3f2fd") + 10);
  });

  it("overrides only light and dark, and falls back for invalid seeds", () => {
    const css = schemeStylesheet(DEFAULT_SEED_COLOR);
    expect(css).toContain('[data-theme="dark"]');
    expect(css).not.toContain("contrast");
    expect(schemeTokens("not-a-color")).toEqual(schemeTokens(DEFAULT_SEED_COLOR));
    expect(normalizeEditorPreferences({ seedColor: "#ABCDEF" }).seedColor).toBe("#abcdef");
    expect(normalizeEditorPreferences({ seedColor: "red" }).seedColor).toBe(DEFAULT_SEED_COLOR);
  });

  it("labels swatches with readable text", () => {
    expect(textOn("#ffeb3b")).toBe("#000000");
    expect(textOn("#1a237e")).toBe("#ffffff");
  });
});
