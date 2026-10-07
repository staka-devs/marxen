// Local Shiki highlighting (Issue #6). Themes and languages ship in the
// bundle; nothing is fetched from a CDN. Dual light/dark variables are
// emitted so `styles.css` can follow the app theme via `[data-theme]`.

import { createHighlighter, type Highlighter } from "shiki";

const THEMES = ["github-light", "github-dark"] as const;

// Languages preloaded for offline highlighting. Special fenced blocks
// (mermaid / geojson / topojson / stl / math) never reach Shiki: they get
// dedicated local views. Anything else unknown falls back to plain text.
const LANGS = [
  "rust",
  "typescript",
  "javascript",
  "tsx",
  "json",
  "jsonc",
  "markdown",
  "bash",
  "shell",
  "toml",
  "yaml",
  "html",
  "css",
  "python",
  "text",
  "plaintext",
] as const;

let cached: Promise<Highlighter> | null = null;

function highlighter(): Promise<Highlighter> {
  if (!cached) {
    cached = createHighlighter({ themes: [...THEMES], langs: [...LANGS] }).catch((cause) => {
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
    if (!hl.getLoadedLanguages().includes(normalized as (typeof LANGS)[number])) {
      const loaded = hl.getLoadedLanguages();
      if (!loaded.includes(normalized)) return null;
    }
    return hl.codeToHtml(code, { lang: normalized, themes: { light: "github-light", dark: "github-dark" } });
  } catch {
    return null;
  }
}
