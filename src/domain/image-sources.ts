// Deterministic local-image source helpers (domain).
//
// Relative-source detection, percent-decoding, and resolved-URL safety. No
// Tauri, DOM, React, or browser globals: DOM hydration lives in presentation
// and byte loading lives in infrastructure.

/**
 * Resolve a relative image source to a displayable URL, or null to keep it.
 *
 * Supplied by the UI layer (backed by the Rust loader); abort-aware so stale
 * passes discard late bytes.
 */
export type ImageResolver = (src: string, signal: AbortSignal) => Promise<string | null>;

/** Absolute URLs, fragments, and schemes that are never author-relative. */
const ABSOLUTE_URL = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|#)/;

/**
 * Check whether a source is author-relative (including Unicode names).
 *
 * Empty and absolute sources return false so only relative images hydrate.
 */
export function isRelativeImageSrc(src: string): boolean {
  const trimmed = src.trim();
  if (trimmed === "") return false;
  return !ABSOLUTE_URL.test(trimmed);
}

/**
 * Decode a percent-encoded pipeline source back to the authored path.
 *
 * The pipeline encodes non-ASCII (`日本語.png`); the loader works with real
 * paths, so decode first. Malformed escapes stay raw instead of throwing.
 */
export function decodeImageSrc(src: string): string {
  try {
    return decodeURIComponent(src);
  } catch {
    return src;
  }
}

/** URL schemes allowed to replace an image source after loading. */
const SAFE_RESOLVED_URL = /^(?:https?:|blob:|asset:|tauri:|data:image\/)/i;

/**
 * Check whether a resolved URL is safe to swap into an image source.
 *
 * Only bytes-backed or app-local targets may replace a source, so a faulty
 * loader can never inject script execution.
 */
export function isSafeResolvedUrl(url: string): boolean {
  return SAFE_RESOLVED_URL.test(url.trim());
}
