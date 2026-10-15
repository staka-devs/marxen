import { localizedFailure } from "../../../domain/localization";
import type { LocalizedText } from "../../../contracts/localization";
import { useI18n } from "../../i18n/I18nProvider";
// Vim key routing for the shell editor (presentation).
//
// Event-time work stays synchronous so multi-key sequences and operator
// prefixes never block: each keystroke enqueues immediately and the actual
// native mode is read inside the serial queue. Printable keys never consult
// stale Normal/Insert refs. IME preedit never becomes a motion. All native
// access arrives via the document session and injected ports, so this hook
// never imports infrastructure directly.

import { useCallback, useRef } from "react";
import type { DocumentSnapshot, TextEdit, YankCopy } from "../../../contracts/contracts";
import { StaleResync, workspaceErrorText } from "../../../domain/document-errors";
import { serializeVimKey } from "../../../domain/vim-keys";
import { isMarkdownPath } from "../../../domain/workspace-files";
import { correspondSource as correspondSnapshotSource, resolveEditRange } from "../../../domain/coordinates/selection-range";
import type { EditorSelection } from "../../editor/CodeMirrorEditor";
import type { NavBasis } from "../shellView";
import type { DocumentSession } from "./useDocumentSession";

/** Injected ports for Vim key routing. */
export interface VimEditingArgs {
  /** True on desktop; the browser demo ignores editor keys. */
  desktop: boolean;
  /** Cursor motion basis for display-basis arrow handling. */
  navBasis: NavBasis;
  /** Persistent Markdown prose Enter preference; native mappings retain priority. */
  hardBreakOnEnter?: boolean;
  /** Surface a notice without importing shell state. */
  notify: (message: LocalizedText | null, kind?: import("../../workspace/Notifications").NoticeKind) => void;
  /** Document session owning docs, selections, cursors, and mutations. */
  session: DocumentSession;
}

/** Vim routing callbacks and shared gesture refs. */
export interface VimEditing {
  /** Pending keyboard-paste gesture consumed once by the capture handler. */
  pendingPasteRef: React.MutableRefObject<{ time: number; dropText: boolean } | null>;
  /** Capture the exact half-open range plus full source for one edit. */
  takeRange: (id: string) => { range: { start: number; end: number }; fullText: string };
  /** Admit a stale range once when full source still matches. */
  correspondRange: (
    snapshot: DocumentSnapshot,
    range: { start: number; end: number },
    fullText: string,
  ) => { start: number; end: number } | null;
  /** Route one printable char with execution-time mode and single retry. */
  routeCharKey: (
    id: string,
    key: string,
    range: { start: number; end: number },
    fullText: string,
    retried?: boolean,
  ) => Promise<void>;
  /** Apply one captured paste as a single serial task exactly once. */
  routeCapturedPaste: (
    id: string,
    keyNotation: string | null,
    text: string,
    range: { start: number; end: number },
    fullText: string,
    retried?: boolean,
  ) => Promise<void>;
  /** Route Vim keys natively with burst revision binding at execution. */
  routeVimKeys: (id: string, keys: string) => Promise<void>;
  /** Report whether a native key transition still owns the next input cursor. */
  isNativeInputPending: (id: string) => boolean;
  /** Route GUI input using native cursor semantics during pending key transitions. */
  routeGuiEdits: (id: string, edits: TextEdit[], beforeText: string, selection?: EditorSelection, key?: string, nativeCursor?: boolean) => void;
  /** Shell key router preserving IME, mappings, and display motion. */
  onEditorKeyDown: (event: React.KeyboardEvent) => void;
  /** Apply a range helper at the active selection as one edit. */
  guiAtSelection: (fn: (text: string, anchor: number, head: number) => TextEdit[], emptyCaretInset?: number) => void;
}

/**
 * Own Vim key routing: optimistic ranges, mapping-first execution, and paste.
 *
 * Returns stable routing callbacks plus the pending-paste ref consumed by the
 * image attachment hook; the document session keeps all React state.
 */
export function useVimEditing(args: VimEditingArgs): VimEditing {
  const { message } = useI18n();
  const { desktop, navBasis, notify, session } = args;
  const setNotice = notify;
  const {
    registry,
    docsRef,
    activeRef,
    selections,
    setSelections,
    echoCursor,
    vimModeRef,
    setVimKeys,
    setCopyReady,
    caretRef,
    bumpSelectionGen,
    isSelectionGenCurrent,
    currentSelectionGen,
    mergeSnapshot,
    sayStale,
    refreshModeCursor,
    applyEdits,
    applyNativeText,
    writeYankToClipboard,
  } = session;
  const navRef = useRef(navBasis);
  navRef.current = navBasis;
  const hardBreakRef = useRef(args.hardBreakOnEnter ?? false);
  hardBreakRef.current = args.hardBreakOnEnter ?? false;
  // Insert-mode keyboard Ctrl+V is recorded here WITHOUT preventing default:
  // the follow-up paste event carries the bytes synchronously (OS image
  // pastes emit no readable text via readText, and readText can fail in a
  // native WebView while normal paste works). The capture handler below
  // prevents default synchronously and routes exactly once.
  const pendingPasteRef = useRef<{ time: number; dropText: boolean } | null>(null);
  // Native edits can move the caret before their display acknowledgement.
  // Following printable keys stay native until that position is known.
  const pendingNativeInput = useRef<Record<string, number>>({});

  /** Read the current native transition count for a composition capture. */
  const isNativeInputPending = useCallback((id: string) => (pendingNativeInput.current[id] ?? 0) > 0, []);

  /** Capture the exact half-open range plus full source for one edit. */
  const takeRange = useCallback(
    (id: string): { range: { start: number; end: number }; fullText: string } => {
      const text = docsRef.current[id]?.text ?? "";
      const sel = selections[id] ?? { anchor: 0, head: 0 };
      const range = resolveEditRange(text.length, sel.anchor, sel.head, caretRef.current[id]);
      return { range, fullText: text };
    },
    [docsRef, caretRef, selections],
  );

  /**
   * Admit a stale range once when full source still matches.
   *
   * A newer revision must never silently reuse an old range: after a stale
   * rejection, retry once only when the fresh source still equals the
   * captured source in full. A matching excerpt at the same offset alone is
   * not enough, since unrelated changes can shift repeated text.
   */
  const correspondRange = useCallback(
    (snapshot: DocumentSnapshot, range: { start: number; end: number }, fullText: string): { start: number; end: number } | null =>
      correspondSnapshotSource(snapshot.text, fullText, range),
    [],
  );

  /** Route one printable char with execution-time mode and single retry. */
  const routeCharKey = useCallback(
    async (id: string, key: string, range: { start: number; end: number }, fullText: string, retried = false): Promise<void> => {
      if (!registry) {
        setNotice(message("ブラウザ表示では編集できません。デスクトップで開いてください。"));
        return;
      }
      if (!docsRef.current[id]) return;
      setVimKeys((prev) => (prev + key).slice(-24));
      const gen = retried ? currentSelectionGen(id) : bumpSelectionGen(id);
      try {
        const decision = await registry.routeCharKey(id, key, range, (copy) => writeYankToClipboard(copy, id));
        if (decision.action === "vim") {
          if (isSelectionGenCurrent(id, gen)) setCopyReady(decision.copyReady ? id : null);
          // Native edit (any mode): the cursor truth comes from the refresh.
          mergeSnapshot(decision.snapshot);
          await refreshModeCursor(id, gen);
          return;
        }
        if (!isSelectionGenCurrent(id, gen)) {
          // A newer gesture landed mid-flight: keep its range, still absorb
          // the authoritative text.
          mergeSnapshot(decision.snapshot);
          return;
        }
        const next = range.start + key.length;
        caretRef.current[id] = next;
        setSelections((prev) => ({ ...prev, [id]: { anchor: next, head: next } }));
        echoCursor(id, next, next);
        mergeSnapshot(decision.snapshot);
      } catch (cause) {
        if (cause instanceof StaleResync) {
          sayStale(cause.snapshot);
          // Never retry against unknown source automatically: once, and only
          // when the fresh source still equals the captured source in full.
          if (!retried && isSelectionGenCurrent(id, gen)) {
            const fresh = correspondRange(cause.snapshot, range, fullText);
            if (fresh) await routeCharKey(id, key, fresh, cause.snapshot.text, true);
          }
        } else {
          setNotice(localizedFailure(cause, workspaceErrorText), "error");
        }
      }
    },
    [registry, mergeSnapshot, refreshModeCursor, sayStale, echoCursor, correspondRange, bumpSelectionGen, currentSelectionGen, isSelectionGenCurrent, writeYankToClipboard, docsRef, caretRef, setVimKeys, notify],
  );

  // Captured paste replaces the exact half-open range as one serial edit and
  // collapses there. Context-menu pastes (no keyboard gesture) never simulate
  // a mapping and insert directly.
  /** Apply one captured paste as a single serial task exactly once. */
  const routeCapturedPaste = useCallback(
    async (
      id: string,
      keyNotation: string | null,
      text: string,
      range: { start: number; end: number },
      fullText: string,
      retried = false,
    ): Promise<void> => {
      if (!registry) {
        setNotice(message("ブラウザ表示では編集できません。デスクトップで開いてください。"));
        return;
      }
      if (!docsRef.current[id]) return;
      if (text === "") return;
      const gen = retried ? currentSelectionGen(id) : bumpSelectionGen(id);
      try {
        const decision = await registry.routeCapturedPaste(id, keyNotation, text, range, fullText, isNativeInputPending(id));
        if (decision.action === "vim") {
          mergeSnapshot(decision.snapshot);
          await refreshModeCursor(id, gen);
          return;
        }
        if (!isSelectionGenCurrent(id, gen)) {
          mergeSnapshot(decision.snapshot);
          return;
        }
        const next = range.start + text.length;
        caretRef.current[id] = next;
        setSelections((prev) => ({ ...prev, [id]: { anchor: next, head: next } }));
        echoCursor(id, next, next);
        mergeSnapshot(decision.snapshot);
      } catch (cause) {
        if (cause instanceof StaleResync) {
          sayStale(cause.snapshot);
          if (!retried && isSelectionGenCurrent(id, gen)) {
            const fresh = correspondRange(cause.snapshot, range, fullText);
            if (fresh) await routeCapturedPaste(id, keyNotation, text, fresh, cause.snapshot.text, true);
          }
        } else {
          setNotice(localizedFailure(cause, workspaceErrorText), "error");
        }
      }
    },
    [registry, mergeSnapshot, refreshModeCursor, sayStale, echoCursor, correspondRange, bumpSelectionGen, currentSelectionGen, isSelectionGenCurrent, docsRef, caretRef, isNativeInputPending, notify],
  );

  /** Keep committed text on the native queue until its pending cursor is known. */
  const routeGuiEdits = useCallback((id: string, edits: TextEdit[], beforeText: string, selection?: EditorSelection, key?: string, nativeCursor = false) => {
    const edit = edits[0];
    if ((nativeCursor || isNativeInputPending(id)) && selection && edits.length === 1 && (nativeCursor || edit.range.start === edit.range.end)) {
      pendingNativeInput.current[id] = (pendingNativeInput.current[id] ?? 0) + 1;
      void applyNativeText(id, edit.text).finally(() => { pendingNativeInput.current[id] -= 1; });
      return;
    }
    void applyEdits(id, edits, beforeText, selection, key);
  }, [applyEdits, applyNativeText, isNativeInputPending]);

  // -- Vim key router (shell level; CodeMirror internals untouched) ---------
  //
  // Event-time work stays synchronous (no awaiting before enqueue) so
  // multi-key g/gg and operator prefixes never block: each keystroke is
  // queued immediately and the actual native mode is read inside the serial
  // queue, where routing and mapping checks happen at execution. Printable
  // keys therefore never consult stale Normal/Insert refs for routing.
  /** Route Vim keys natively with burst revision binding at execution. */
  const routeVimKeys = useCallback(
    async (id: string, keys: string) => {
      if (!registry) {
        setNotice(message("ブラウザ表示では編集できません。デスクトップで開いてください。"));
        return;
      }
      if (!docsRef.current[id]) return;
      setVimKeys((prev) => (prev + keys).slice(-24));
      const gen = bumpSelectionGen(id);
      pendingNativeInput.current[id] = (pendingNativeInput.current[id] ?? 0) + 1;
      try {
        // Revision binds at queue execution inside the client, so bursts
        // order against successive acknowledgements.
        const range = takeRange(id).range;
        if ((keys === "<Tab>" || keys === "<S-Tab>") && isMarkdownPath(docsRef.current[id].path)) {
          const result = await registry.routeTableTab(id, keys === "<S-Tab>", range.end, takeRange(id).fullText, (copy) => writeYankToClipboard(copy, id));
          if ("cursor" in result) {
            if (isSelectionGenCurrent(id, gen)) {
              setCopyReady(null);
              caretRef.current[id] = result.cursor.head;
              setSelections((previous) => ({ ...previous, [id]: { anchor: result.cursor.anchor, head: result.cursor.head } }));
              echoCursor(id, result.cursor.anchor, result.cursor.head);
            }
          } else { mergeSnapshot(result.snapshot); if (activeRef.current === id && isSelectionGenCurrent(id, gen)) setCopyReady(result.copyReady ? id : null); await refreshModeCursor(id, gen); }
          return;
        }
        const result = keys === "<CR>" && hardBreakRef.current && isMarkdownPath(docsRef.current[id].path)
          ? await registry.routeEditorEnter(id, true, range.start !== range.end, (copy: YankCopy) => writeYankToClipboard(copy, id))
          : await registry.vimInputWithCopy(id, keys, (copy: YankCopy) => writeYankToClipboard(copy, id));
        mergeSnapshot(result.snapshot);
        if (activeRef.current === id && isSelectionGenCurrent(id, gen)) setCopyReady(result.copyReady ? id : null);
        await refreshModeCursor(id, gen);
      } catch (cause) {
        if (cause instanceof StaleResync) sayStale(cause.snapshot);
        else setNotice(localizedFailure(cause, workspaceErrorText), "error");
      } finally {
        pendingNativeInput.current[id] -= 1;
      }
    },
    [registry, mergeSnapshot, refreshModeCursor, sayStale, bumpSelectionGen, isSelectionGenCurrent, writeYankToClipboard, docsRef, activeRef, setVimKeys, session, notify, takeRange],
  );

  /** Shell key router preserving IME, mappings, and display motion. */
  const onEditorKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!desktop || !registry || !activeRef.current) return;
      if (event.defaultPrevented || event.isPropagationStopped()) return;
      const native = event.nativeEvent;
      // IME preedit (including keyCode 229) is never a Vim motion and never a
      // GUI change here; composition commits flow through the editor once.
      if (native.isComposing || event.key === "Process" || native.keyCode === 229) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest(".cm-content") && (event.key === "ContextMenu" || event.key === "Menu" || (event.key === "F10" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey))) return;
      if (target?.closest("input,textarea,select,[role=\"dialog\"]")) return;
      const mod = event.ctrlKey || event.metaKey;
      const lower = event.key.toLowerCase();
      if (mod && (lower === "p" || lower === "s")) return;
      const id = activeRef.current;
      if (!id) return;
      if (event.key.toLowerCase() === "v" && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
        // Keyboard paste gesture in any mode: record it and let the paste
        // event carry the bytes synchronously. Preventing default here would
        // swallow OS image bytes (no paste event fires) and readText can fail
        // in a native WebView while normal paste works. The capture handler
        // prevents default synchronously and routes text-or-image exactly
        // once. When the gesture was made outside insert/replace, the keydown
        // below already fed it natively (Normal Ctrl+V stays visual-block),
        // so the text half is dropped there to preserve exactly-once native.
        const insertGesture = vimModeRef.current === "insert" || vimModeRef.current === "replace";
        pendingPasteRef.current = { time: Date.now(), dropText: !insertGesture };
        if (!insertGesture) {
          const keys = serializeVimKey({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey });
          if (!keys) return;
          event.preventDefault();
          event.stopPropagation();
          void routeVimKeys(activeRef.current, keys);
        }
        return;
      }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        // CodeMirror displays ordinary Insert input immediately and captures
        // its exact source plus key identity for the mapping-first queue.
        // Native mode transitions keep following keys native until their
        // cursor is known; other surfaces retain their range-based routing.
        const insertHint = vimModeRef.current === "insert" || vimModeRef.current === "replace";
        if (insertHint && (pendingNativeInput.current[id] ?? 0) === 0 && target?.closest(".cm-content")) return;
        event.preventDefault();
        event.stopPropagation();
        if (!docsRef.current[id]) return;
        if (!insertHint || (pendingNativeInput.current[id] ?? 0) > 0) {
          void routeVimKeys(id, event.key);
          return;
        }
        const { range, fullText } = takeRange(id);
        caretRef.current[id] = range.start + event.key.length;
        void routeCharKey(id, event.key, range, fullText);
        return;
      }
      if (navRef.current === "display" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        // Display-basis vertical motion, line start/end, and keyboard
        // selection stay in the editor only outside Visual: in Visual and
        // VisualLine the same keys route natively so x-mode mappings fire
        // instead of being overridden by a stale Normal assumption.
        // Word/textobject/macro keys below still route natively in all
        // non-insert modes.
        const mode = vimModeRef.current;
        if ((mode === "normal" || mode === "insert" || mode === "replace") && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      }
      const keys = serializeVimKey({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey });
      if (!keys) return;
      event.preventDefault();
      event.stopPropagation();
      void routeVimKeys(activeRef.current, keys);
    },
    [desktop, registry, routeVimKeys, routeCharKey, routeCapturedPaste, takeRange, selections],
  );

  /** Apply a range helper at the active selection as one edit. */
  const guiAtSelection = useCallback(
    (fn: (text: string, anchor: number, head: number) => TextEdit[], emptyCaretInset = 0) => {
      const id = activeRef.current;
      if (!id) return;
      if (!registry) {
        setNotice(message("ブラウザ表示では編集できません。デスクトップで開いてください。"));
        return;
      }
      const current = docsRef.current[id];
      if (!current) return;
      const sel = selections[id] ?? { anchor: 0, head: 0 };
      const anchor = Math.min(sel.anchor, current.text.length);
      const head = Math.min(sel.head, current.text.length);
      try {
        const edits = fn(current.text, Math.min(anchor, head), Math.max(anchor, head));
        let next = head;
        let delta = 0;
        for (const change of edits) {
          if (head < change.range.start) break;
          if (head <= change.range.end) { next = change.range.start + delta + change.text.length; break; }
          delta += change.text.length - (change.range.end - change.range.start);
          next = head + delta;
        }
        if (anchor === head && edits.length === 1) next -= emptyCaretInset;
        const commit = applyEdits(id, edits, current.text, { anchor: next, head: next });
        const generation = currentSelectionGen(id);
        void commit.then(() => refreshModeCursor(id, generation));
      } catch (cause) { setNotice(localizedFailure(cause, workspaceErrorText), "error"); }
    },
    [applyEdits, registry, selections, docsRef, activeRef, notify, currentSelectionGen, refreshModeCursor],
  );

  return {
    pendingPasteRef,
    takeRange,
    correspondRange,
    routeCharKey,
    routeCapturedPaste,
    routeVimKeys,
    routeGuiEdits,
    isNativeInputPending,
    onEditorKeyDown,
    guiAtSelection,
  };
}

/** Return type of the Vim editing hook for sibling hook composition. */
export type VimEditingHandle = ReturnType<typeof useVimEditing>;

