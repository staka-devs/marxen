// Local-image byte loader through the Rust workspace (infrastructure).
//
// Resolves relative sources to displayable data URLs with containment and
// type checks on the native side. Abort-aware and document-scoped: late
// responses after switching documents are rejected and failures return null.

import { bytesToDataUrl } from "../../domain/clipboard-text";
import { decodeImageSrc } from "../../domain/image-sources";
import type { ImageResolver } from "../../domain/image-sources";
import { workspaceApi } from "../tauri/workspace-api";
import type { ImageLoader } from "../../application/ports";

/** In-memory data-URL cache keyed by `documentId:src`. */
const cache = new Map<string, string>();

/**
 * Resolve one relative image source to a data URL for a document.
 *
 * Returns null when aborted, when the MIME is not a supported image, or when
 * the loader fails; callers keep alt text instead of faking content.
 */
export async function resolveImageForDocument(documentId: string, src: string, signal: AbortSignal): Promise<string | null> {
  if (signal.aborted) return null;
  const key = `${documentId}:${src}`;
  const cached = cache.get(key);
  if (cached) {
    if (signal.aborted) return null;
    return cached;
  }
  try {
    const data = await workspaceApi.loadImage(documentId, decodeImageSrc(src));
    if (signal.aborted) return null;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(data.mime)) return null;
    const url = bytesToDataUrl(data.mime, data.bytes);
    cache.set(key, url);
    return url;
  } catch {
    return null;
  }
}

/**
 * Clear cached image URLs, e.g. for tests or workspace switches.
 *
 * Production keeps the cache for the session; tests reset between cases.
 */
export function clearImageCache(): void {
  cache.clear();
}

/**
 * Create an abort-aware resolver bound to one document ID.
 *
 * Late responses after switching documents are rejected by comparing against
 * the current ID supplied by `isCurrentDocument`, when provided.
 */
export function makeImageResolver(
  documentId: string,
  isCurrentDocument?: (id: string) => boolean,
): ImageResolver {
  return async (src: string, signal: AbortSignal): Promise<string | null> => {
    if (signal.aborted) return null;
    const url = await resolveImageForDocument(documentId, src, signal);
    if (signal.aborted) return null;
    if (url !== null && isCurrentDocument && !isCurrentDocument(documentId)) return null;
    return url;
  };
}


/** Image loader adapter satisfying the application port with caching. */
export const imageLoader: ImageLoader = {
  /** Resolve a relative source to a displayable URL or null. */
  resolve: resolveImageForDocument,
  /** Shared resolver factory for the active document. */
  forDocument: makeImageResolver,
};

