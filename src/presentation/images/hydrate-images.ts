// DOM image hydration for previews and live widgets (presentation).
//
// Swaps relative `src` after mount through an injected resolver (backed by
// the Rust loader). Each image is attempted once; late, aborted, detached, or
// source-changed results are discarded. Returned URLs are scheme-checked.

import { isRelativeImageSrc, isSafeResolvedUrl, decodeImageSrc, type ImageResolver } from "../../domain/image-sources";

/** Shared live signal for callers that omit an explicit AbortSignal. */
const LIVE_SIGNAL = new AbortController().signal;

/**
 * Hydrate relative images under `root` through `resolveImage`.
 *
 * Marks each image `data-marxen-img` (pending/done/failed) so re-renders do
 * not refetch; resolves when all settle. Failures keep alt text.
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
