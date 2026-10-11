// Image attachments for the shell editor (presentation).
//
// Event-first clipboard and drop handling: paste events are read
// synchronously (text AND image bytes) with default prevented synchronously
// before CodeMirror inserts anything. Image bytes resolve through the Rust
// loader with abort-aware, document-scoped hydration. All native access
// arrives via the session, Vim routing, and injected ports, so this hook
// never imports infrastructure directly.

import { useCallback, useMemo, useRef } from "react";
import type { ImageResolver } from "../../../domain/image-sources";
import { bytesToDataUrl } from "../../../domain/clipboard-text";
import { isMarkdownPath } from "../../../domain/workspace-files";
import { READONLY_MESSAGE, StaleResync, workspaceErrorText } from "../../../domain/document-errors";
import type { NoticeKind } from "../../workspace/Notifications";
import type { ImageDrop } from "../../workspace/ImageDropZone";
import type { ImageLoader, WorkspaceGateway } from "../../../application/ports";
import type { DocumentSession } from "./useDocumentSession";
import type { VimEditing } from "./useVimEditing";

/** Injected ports for image attachments. */
export interface ImageAttachmentsArgs {
  /** True on desktop; the browser demo disables drops and pastes. */
  desktop: boolean;
  /** Surface a notice without importing shell state. */
  notify: (message: string | null, kind?: NoticeKind) => void;
  /** Document session owning docs, selections, cursors, and snapshots. */
  session: DocumentSession;
  /** Vim routing for ranges and captured paste execution. */
  vim: VimEditing;
  /** Workspace file gateway for image insertion. */
  workspaceGateway?: WorkspaceGateway;
  /** Image byte loader for preview hydration. */
  imageLoader?: ImageLoader;
  /** Reload workspace entries after workspace image drops. */
  loadEntries: () => Promise<unknown>;
}

/** Image attachment operations and preview resolvers. */
export interface ImageAttachments {
  /** Create an abort-aware resolver bound to one document ID. */
  makeImageResolver: (documentId: string) => ImageResolver;
  /** Shared resolver for live, read, and split previews. */
  previewResolver: ImageResolver | undefined;
  /** Live preview resolver alias sharing the preview instance. */
  liveResolver: ImageResolver | undefined;
  /** Read preview resolver alias sharing the preview instance. */
  readResolver: ImageResolver | undefined;
  /** Paste image files chaining revisions so multi-file never goes stale. */
  pasteImageFiles: (id: string, files: File[], range: { start: number; end: number }) => Promise<void>;
  /** Capture paste synchronously routing text-or-image exactly once. */
  onPasteCapture: (event: React.ClipboardEvent) => void;
  /** Route workspace, native, and file drops through the registry. */
  handleImageDrop: (drop: ImageDrop, range: { start: number; end: number }) => void;
  /** Current selection as a half-open range for drop positioning. */
  dropSelection: { start: number; end: number };
}

/**
 * Own image attachments: resolvers, paste capture, and drop routing.
 *
 * Returns preview resolvers plus paste/drop callbacks; the document session
 * keeps all React state and the Vim hook owns range capture.
 */
export function useImageAttachments(args: ImageAttachmentsArgs): ImageAttachments {
  const { desktop, notify, session, vim, workspaceGateway, imageLoader, loadEntries } = args;
  const setNotice = notify;
  const {
    registry,
    docsRef,
    activeRef,
    active,
    selections,
    setSelections,
    echoCursor,
    vimModeRef,
    caretRef,
    bumpSelectionGen,
    isSelectionGenCurrent,
    mergeSnapshot,
    sayStale,
  } = session;
  const { takeRange, routeCapturedPaste, pendingPasteRef } = vim;

  // Shared local-image hydration (ADR-0063): relative sources resolve through
  // the Rust workspace loader (containment/symlink/type checked) to data URLs.
  // Abort-aware and stale-safe; failures keep alt text, never fake content.
  // No secrets touch localStorage; credentials stay in the OS store.
  // The resolver is bound to an explicit document ID: late responses after
  // switching documents are rejected, and the read preview is keyed by
  // document so identical Markdown with the same filename cannot reuse
  // another document's bytes from an already-hydrated node.
  const imageUrlCache = useRef(new Map<string, string>());
  /**
   * Create an abort-aware resolver bound to one document ID.
   *
   * Prefers the injected image loader; falls back to the workspace gateway
   * with a local cache so tests without a loader still hydrate. Late
   * responses after switching documents are rejected.
   */
  const makeImageResolver = useCallback(
    (documentId: string): ImageResolver => {
      if (imageLoader) {
        const base = imageLoader.forDocument(documentId);
        return async (src: string, signal: AbortSignal): Promise<string | null> => {
          if (!desktop) return null;
          if (signal.aborted) return null;
          const url = await base(src, signal);
          if (signal.aborted) return null;
          if (activeRef.current !== documentId) return null;
          return url;
        };
      }
      return async (src: string, signal: AbortSignal): Promise<string | null> => {
        if (!desktop) return null;
        if (signal.aborted) return null;
        const key = `${documentId}:${src}`;
        const cached = imageUrlCache.current.get(key);
        if (cached) {
          if (signal.aborted) return null;
          return cached;
        }
        try {
          if (!workspaceGateway) return null;
          const data = await workspaceGateway.loadImage(documentId, src);
          if (signal.aborted) return null;
          // The user may have switched documents while the bytes were in
          // flight: only the resolver's own document may consume them.
          if (activeRef.current !== documentId) return null;
          if (!/^image\/(png|jpeg|gif|webp)$/.test(data.mime)) return null;
          const url = bytesToDataUrl(data.mime, data.bytes);
          imageUrlCache.current.set(key, url);
          return url;
        } catch {
          return null;
        }
      };
    },
    [desktop, imageLoader, workspaceGateway, activeRef],
  );
  // Live, read, and split previews share one resolver for the active document:
  // the bodies were identical, and the preview keys already isolate documents.
  /** Shared image resolver for live, read, and split previews. */
  const previewResolver = useMemo(
    () => (desktop && active ? makeImageResolver(active.documentId) : undefined),
    [desktop, active, makeImageResolver],
  );
  const liveResolver = previewResolver;
  const readResolver = previewResolver;

  // -- paste text/images (capture phase; preview pipeline untouched) --------
  //
  // Event-first clipboard: the paste event's clipboardData is read
  // synchronously (text AND image bytes) and default is prevented
  // synchronously, before CodeMirror can insert anything. No async
  // preventDefault after insertion, no readText round-trip, exactly once.
  /** Paste image files chaining revisions so multi-file never goes stale. */
  const pasteImageFiles = useCallback(
    async (id: string, files: File[], range: { start: number; end: number }) => {
      if (!registry) {
        setNotice(READONLY_MESSAGE);
        return;
      }
      // The first file replaces the exact selected range; each following file
      // appends after the previously inserted Markdown instead of reusing the
      // original offset. Revisions chain locally: each call builds on the
      // previous result, so the loop never goes stale on itself.
      const gen = bumpSelectionGen(id);
      let cursor = { ...range };
      let revision = docsRef.current[id]?.revision ?? 0;
      let previousLength = docsRef.current[id]?.text.length ?? 0;
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024) {
          setNotice("対応画像（PNG/JPEG/GIF/WebP、20 MiB 以下）のみ扱えます。");
          continue;
        }
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const result = await registry.pasteImage(
            { request: { documentId: id, baseRevision: revision }, name: file.name, bytes, range: cursor },
          );
          revision = result.snapshot.revision;
          const inserted = result.snapshot.text.length - previousLength;
          previousLength = result.snapshot.text.length;
          const next = cursor.end + inserted;
          cursor = { start: next, end: next };
          if (!isSelectionGenCurrent(id, gen)) {
            mergeSnapshot(result.snapshot);
            setNotice(`画像を挿入しました（${result.path}）。`);
            continue;
          }
          caretRef.current[id] = next;
          setSelections((prev) => ({ ...prev, [id]: { anchor: next, head: next } }));
          echoCursor(id, next, next);
          mergeSnapshot(result.snapshot);
          setNotice(`画像を挿入しました（${result.path}）。`);
        } catch (cause) {
          // A stale range rejects without applying: surface it once and
          // never retry a file write that might already have landed.
          if (cause instanceof StaleResync) sayStale(cause.snapshot);
          else setNotice(workspaceErrorText(cause), "error");
        }
      }
    },
    [registry, mergeSnapshot, sayStale, echoCursor, isSelectionGenCurrent, bumpSelectionGen, docsRef, caretRef, setSelections, notify],
  );

  /** Capture paste synchronously routing text-or-image exactly once. */
  const onPasteCapture = useCallback(
    (event: React.ClipboardEvent) => {
      if (!desktop || !registry || !activeRef.current) return;
      const id = activeRef.current;
      if (!docsRef.current[id]) return;
      const data = event.clipboardData;
      const files = isMarkdownPath(docsRef.current[id].path) ? Array.from(data?.files ?? []).filter((file) => /^image\/(png|jpeg|gif|webp)$/.test(file.type)) : [];
      if (files.length > 0) {
        // Empty text alongside images is a pure image paste: files win and
        // the (empty) text is ignored so nothing inserts twice.
        event.preventDefault();
        event.stopPropagation();
        pendingPasteRef.current = null;
        const { range } = takeRange(id);
        void pasteImageFiles(id, files, range);
        return;
      }
      const text = data?.getData("text/plain") ?? data?.getData("text") ?? "";
      if (text === "") {
        pendingPasteRef.current = null;
        return;
      }
      const pending = pendingPasteRef.current !== null && Date.now() - pendingPasteRef.current.time < 1500
        ? pendingPasteRef.current
        : null;
      pendingPasteRef.current = null;
      if (pending !== null) {
        // Keyboard paste: prevent synchronously before CodeMirror default,
        // then let the serial queue read the actual mode. A gesture made
        // outside insert/replace was already fed natively above, so its text
        // half is dropped here to preserve exactly-once native.
        event.preventDefault();
        event.stopPropagation();
        if (pending.dropText) return;
        const { range, fullText } = takeRange(id);
        void routeCapturedPaste(id, "<C-v>", text, range, fullText);
        return;
      }
      const mode = vimModeRef.current;
      if (mode !== "insert" && mode !== "replace") return;
      // Context-menu paste in insert/replace inserts directly without
      // simulating a mapping. Prevent synchronously before CodeMirror default.
      event.preventDefault();
      event.stopPropagation();
      const { range, fullText } = takeRange(id);
      void routeCapturedPaste(id, null, text, range, fullText);
    },
    [desktop, registry, takeRange, pasteImageFiles, routeCapturedPaste, docsRef, activeRef, pendingPasteRef, vimModeRef],
  );

  /** Route workspace, native, and file drops through the registry. */
  const handleImageDrop = useCallback((drop: ImageDrop, range: { start: number; end: number }) => {
    const id = activeRef.current;
    const doc = id ? docsRef.current[id] : undefined;
    if (!id || !doc || !registry || !isMarkdownPath(doc.path)) return;
    if (drop.kind === "files") {
      void pasteImageFiles(id, drop.files, range);
      return;
    }
    const gen = bumpSelectionGen(id);
    const request = { documentId: id, baseRevision: doc.revision };
    void (async () => {
      try {
        let revision = request.baseRevision;
        let cursor = range;
        let length = doc.text.length;
        const paths = drop.kind === "workspace" ? [drop.path] : drop.paths;
        for (const path of paths) {
          const result = drop.kind === "workspace"
            ? await registry.insertWorkspaceImage({ documentId: id, baseRevision: revision }, path, cursor)
            : (await registry.importExternalImage({ documentId: id, baseRevision: revision }, path, cursor)).snapshot;
          revision = result.revision;
          const next = cursor.end + result.text.length - length;
          length = result.text.length;
          cursor = { start: next, end: next };
          mergeSnapshot(result);
          if (isSelectionGenCurrent(id, gen)) {
            caretRef.current[id] = next;
            setSelections(prev => ({ ...prev, [id]: { anchor: next, head: next } }));
            echoCursor(id, next, next);
          }
        }
        await loadEntries();
        setNotice("画像を挿入しました。");
      } catch (cause) {
        if (cause instanceof StaleResync) sayStale(cause.snapshot);
        else setNotice(workspaceErrorText(cause), "error");
      }
    })();
  }, [registry, pasteImageFiles, bumpSelectionGen, mergeSnapshot, isSelectionGenCurrent, echoCursor, loadEntries, sayStale, docsRef, activeRef, caretRef, setSelections, notify]);

  /** Current selection as a half-open range for drop positioning. */
  const dropSelection = active ? {
    start: Math.min(selections[active.documentId]?.anchor ?? 0, selections[active.documentId]?.head ?? 0),
    end: Math.max(selections[active.documentId]?.anchor ?? 0, selections[active.documentId]?.head ?? 0),
  } : { start: 0, end: 0 };

  return {
    makeImageResolver,
    previewResolver,
    liveResolver,
    readResolver,
    pasteImageFiles,
    onPasteCapture,
    handleImageDrop,
    dropSelection,
  };
}

/** Return type of the image attachments hook for shell composition. */
export type ImageAttachmentsHandle = ReturnType<typeof useImageAttachments>;

