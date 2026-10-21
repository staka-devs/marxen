// Material 3 dynamic color for the app chrome (domain).
//
// One seed color yields the light and dark token sets through Material's
// fidelity scheme: tones follow the role (so text stays readable) while the
// seed's chroma is kept, so a vivid A-shade gives a vivid accent and a pale
// 50-shade a soft one. High contrast keeps its fixed black/white tokens.

import { Hct, SchemeFidelity, argbFromHex, hexFromArgb, type DynamicScheme } from "@material/material-color-utilities";

/** Default seed: Material Blue 700, close to VS Code's accent. */
export const DEFAULT_SEED_COLOR = "#1976d2";

/** Whether a stored value is a `#rrggbb` seed color. */
export function isSeedColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

/** Map Material roles onto the app's CSS tokens. */
function tokens(scheme: DynamicScheme): Record<string, string> {
  return {
    "--background": hexFromArgb(scheme.surface),
    "--foreground": hexFromArgb(scheme.onSurface),
    "--card": hexFromArgb(scheme.surfaceContainerLow),
    "--muted": hexFromArgb(scheme.surfaceContainerHighest),
    "--muted-foreground": hexFromArgb(scheme.onSurfaceVariant),
    "--border": hexFromArgb(scheme.outlineVariant),
    "--primary": hexFromArgb(scheme.primary),
    "--primary-foreground": hexFromArgb(scheme.onPrimary),
    "--vim-normal": hexFromArgb(scheme.primary),
  };
}

/** Light and dark token sets generated from one seed color. */
export function schemeTokens(seed: string): { light: Record<string, string>; dark: Record<string, string> } {
  const source = Hct.fromInt(argbFromHex(isSeedColor(seed) ? seed : DEFAULT_SEED_COLOR));
  return {
    light: tokens(new SchemeFidelity(source, false, 0)),
    dark: tokens(new SchemeFidelity(source, true, 0)),
  };
}

/** Stylesheet overriding the light and dark tokens; high contrast is left untouched. */
export function schemeStylesheet(seed: string): string {
  const { light, dark } = schemeTokens(seed);
  /** Serialize one token set as CSS declarations. */
  const block = (values: Record<string, string>) => Object.entries(values).map(([name, value]) => `${name}: ${value};`).join(" ");
  return `:root, [data-theme="light"] { ${block(light)} }\n[data-theme="dark"] { ${block(dark)} }\n`;
}

/** Black or white text, whichever reads better on a swatch (Material tone above 60 is light). */
export function textOn(color: string): "#000000" | "#ffffff" {
  return Hct.fromInt(argbFromHex(color)).tone > 60 ? "#000000" : "#ffffff";
}
