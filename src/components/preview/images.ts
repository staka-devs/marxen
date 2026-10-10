// Shared local-image hydration for read previews and live widgets
// (Issue #6, ADR-0063).
//
// The pipeline keeps relative image sources verbatim (never absolute live
// paths, never file://): resolving them to displayable bytes stays behind
// an abort-aware callback the UI layer supplies (backed by the Rust
// workspace loader with its containment/symlink/type checks). This module
// only swaps `src` after mount when the resolver answers in time, the pass
// is not aborted, the node is still connected, and its source is unchanged
// (switched documents and reused widgets are ignored). Returned URLs are
// scheme-checked so a faulty loader can never inject script execution.

/** Resolve a relative image source to a displayable URL, or null to keep it. */
export type ImageResolver = (src: string, signal: AbortSignal) => Promise<string | null>;

const ABSOLUTE_URL = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|#)/;

/** True for author-relative sources (including Unicode names). */
export function isRelativeImageSrc(src: string): boolean {
  const trimmed = src.trim();
  if (trimmed === "") return false;
  return !ABSOLUTE_URL.test(trimmed);
}

/**
 * The pipeline percent-encodes non-ASCII sources (`日本語.png` becomes
 * `%E6%97%A5...`); the loader works with real filesystem paths, so decode
 * back to the authored form before resolving. Malformed escapes stay raw.
 */
export function decodeImageSrc(src: string): string {
  try {
    return decodeURIComponent(src);
  } catch {
    return src;
  }
}

const SAFE_RESOLVED_URL = /^(?:https?:|blob:|asset:|tauri:|data:image\/)/i;

/** Only bytes-backed or app-local targets may replace an image source. */
export function isSafeResolvedUrl(url: string): boolean {
  return SAFE_RESOLVED_URL.test(url.trim());
}

const LIVE_SIGNAL = new AbortController().signal;

/**
 * Swap relative images under `root` through `resolveImage`. Each image is
 * attempted once (marked `data-marxen-img`); late, aborted, detached, or
 * source-changed results are discarded. Resolves when all settle.
 */
export async function hydrateLocalImages(root: HTMLElement, resolveImage: ImageResolver, signal?: AbortSignal): Promise<void> {
  const active = signal ?? LIVE_SIGNAL;
  if (active.aborted) return;
  const images = [...root.querySelectorAll<HTMLImageElement>("img:not([data-marxen-img])")];
  await Promise.all(
    images.map(async (img) => {
      const original = img.getAttribute("src") ?? "";
      if (!isRelativeImageSrc(original)) return;
      img.setAttribute("data-marxen-img", "pending");
      let resolved: string | null;
      try {
        resolved = await resolveImage(decodeImageSrc(original), active);
      } catch {
        img.setAttribute("data-marxen-img", "failed");
        return;
      }
      if (active.aborted) return;
      if (!img.isConnected) return;
      // The node may have been recycled for another document: only the
      // source we resolved for may be replaced.
      if (img.getAttribute("src") !== original) return;
      if (resolved === null || !isSafeResolvedUrl(resolved)) {
        img.setAttribute("data-marxen-img", "failed");
        return;
      }
      img.setAttribute("src", resolved);
      img.setAttribute("data-marxen-img", "done");
    }),
  );
}
