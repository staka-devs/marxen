// Local Shiki highlighting (Issue #6). Themes and languages ship in the
// bundle; nothing is fetched from a CDN. Dual light/dark variables are
// emitted so `styles.css` can follow the app theme via `[data-theme]`.

import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";

// Languages preloaded for offline highlighting. Special fenced blocks
// (mermaid / geojson / topojson / stl / math) never reach Shiki: they get
// dedicated local views. Anything else unknown falls back to plain text.
let cached: Promise<HighlighterCore> | null = null;

/**
 * Get the cached Shiki highlighter, creating once with bundled themes/langs.
 *
 * Resets the cache on failure so the next call retries instead of hanging.
 */
function highlighter(): Promise<HighlighterCore> {
  if (!cached) {
    cached = createHighlighterCore({
      themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
      langs: [
        import("shiki/langs/rust.mjs"),
        import("shiki/langs/typescript.mjs"),
        import("shiki/langs/javascript.mjs"),
        import("shiki/langs/tsx.mjs"),
        import("shiki/langs/json.mjs"),
        import("shiki/langs/jsonc.mjs"),
        import("shiki/langs/markdown.mjs"),
        import("shiki/langs/bash.mjs"),
        import("shiki/langs/toml.mjs"),
        import("shiki/langs/yaml.mjs"),
        import("shiki/langs/html.mjs"),
        import("shiki/langs/css.mjs"),
        import("shiki/langs/python.mjs"),
      ],
      engine: createOnigurumaEngine(import("shiki/wasm")),
    }).catch((cause) => {
      cached = null;
      throw cause;
    });
  }
  return cached;
}

/**
 * Highlight `code` as `lang`. Returns the Shiki `<pre>` HTML, or null when
 * the language is unknown or highlighting fails (caller shows plain text).
 */
export async function highlightCode(code: string, lang: string): Promise<string | null> {
  const normalized = lang.trim().toLowerCase();
  if (normalized === "") return null;
  try {
    const hl = await highlighter();
    if (!["text", "plaintext"].includes(normalized) && !hl.getLoadedLanguages().includes(normalized)) return null;
    return hl.codeToHtml(code, {
      lang: normalized,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    });
  } catch {
    return null;
  }
}
