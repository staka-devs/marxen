// Shared rendering contracts for Issue #6.
//
// A single remark/rehype pipeline (`pipeline.ts`) serves both live and read
// modes. It never mutates the Markdown source: malformed blocks keep their
// raw text and gain a visible Japanese error so editing can continue.

export type RenderDiagnosticCode =
  | "mermaid-invalid"
  | "math-invalid"
  | "geojson-invalid"
  | "topojson-invalid"
  | "stl-invalid";

export interface RenderDiagnostic {
  code: RenderDiagnosticCode;
  /** Japanese message shown next to the raw block. */
  message: string;
  /** 1-based source lines, or null when the position is unknown. */
  startLine: number | null;
  endLine: number | null;
}

export interface SourceBlock {
  /** e.g. `heading`, `paragraph`, `code:rust`, `code:mermaid`, `table`, `math`, `alert:note`. */
  kind: string;
  /** 1-based inclusive source lines shared by live/read scroll mapping. */
  startLine: number;
  endLine: number;
  title?: string;
}

export interface RenderResult {
  /** Sanitized HTML. All libraries render locally; no CDN URLs are emitted. */
  html: string;
  diagnostics: RenderDiagnostic[];
  blocks: SourceBlock[];
}

/** Fenced languages with a dedicated local view (map / 3D / diagram / math). */
export const SPECIAL_LANGUAGES = ["mermaid", "geojson", "topojson", "stl"] as const;
export type SpecialLanguage = (typeof SPECIAL_LANGUAGES)[number];

/**
 * Check whether a fenced language has a dedicated local view.
 *
 * Matches mermaid/geojson/topojson/stl case-insensitively for hydration routing.
 */
export function isSpecialLanguage(lang: string): lang is SpecialLanguage {
  return (SPECIAL_LANGUAGES as readonly string[]).includes(lang.toLowerCase());
}
