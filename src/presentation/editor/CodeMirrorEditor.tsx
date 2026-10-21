import { useCallback, useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, lineNumbers, drawSelection, highlightActiveLine, highlightActiveLineGutter, rectangularSelection, crosshairCursor } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { DocumentSnapshot, TextEdit } from "../../contracts/contracts";
import { createLivePreview, type LivePreviewCallbacks } from "./livePreview";
import { aiDiff } from "./aiDiff";
import { blockCursorWidth } from "./cursorWidth";
import type { ImageResolver } from "../../domain/image-sources";
import { DEFAULT_EDITOR_PREFERENCES, type EditorPreferences } from "../../domain/editor-preferences";
import { useI18n } from "../i18n/I18nProvider";
import type { EditorMenuPoint } from "./EditorMenu";

export interface EditorSelection {
  anchor: number;
  head: number;
  /** Alt+drag rectangle: anchor is the first line's start corner, head the last line's end corner. */
  block?: boolean;
}

/** Report the main range, or an Alt+drag rectangle as its two corners. */
function reportedSelection(selection: EditorState["selection"]): EditorSelection {
  // shortcut: corners come from the first/last line ranges, so a short first/last line clips the
  // block width; tracking the drag's virtual columns would fix that if it matters.
  if (selection.ranges.length > 1) {
    const first = selection.ranges[0];
    const last = selection.ranges[selection.ranges.length - 1];
    return { anchor: first.anchor, head: last.head, block: true };
  }
  return { anchor: selection.main.anchor, head: selection.main.head };
}

/**
 * Vim cursor echo from the shell. Each echo carries a dedicated shell-side
 * sequence token so non-edit navigation applies even when the snapshot
 * revision is unchanged. No revision arithmetic is used here.
 */
export interface ExternalCursor {
  anchor: number;
  head: number;
  seq: number;
}

interface Props {
  /** Open the editor-only menu after capturing a pointer or keyboard gesture. */
  onEditorMenu?: (point: EditorMenuPoint) => void;
  value: string;
  /** Canonical identity also reconciles rejected edits whose text/revision did not change. */
  snapshot?: DocumentSnapshot;
  /** Capture native cursor ownership at composition start, before its ACK returns. */
  shouldUseNativeCursor?: () => boolean;
  editable?: boolean;
  ariaLabel: string;
  testId?: string;
  /** Emit committed document changes as wire range edits. */
  onGuiEdits?: (edits: TextEdit[], beforeText: string, selection?: EditorSelection, key?: string, nativeCursor?: boolean) => void;
  /** Report selection changes for cursor tracking. */
  onSelectionChange?: (selection: EditorSelection) => void;
  initialSelection?: EditorSelection | null;
  externalCursor?: ExternalCursor | null;
  /**
   * Real inline live preview (ADR-0061): inactive blocks render as widgets
   * inside the editor; the selected block stays raw source. Root wires
   * only live mode to true (source/split stay false). Defaults to false so
   * panes that never opt in keep exact source behavior.
   */
  livePreview?: boolean;
  /**
   * Local-image resolver shared with read previews (ADR-0063). Widgets call
   * it after their HTML mounts, on the widget abort lifecycle.
   */
  resolveImage?: ImageResolver;
  preferences?: EditorPreferences;
  vimMode?: string;
  allowTextInput?: boolean;
  /** Positive ticket to focus a committed pane after file navigation. */
  focusRequest?: number;
  /** Text before the latest AI change; when set, changed lines are highlighted inline. */
  aiBaseline?: string | null;
}

/** Common prefix/suffix diff as a single wire range edit. */
export function singleEditFromDiff(before: string, after: string): TextEdit[] | null {
  if (before === after) return null;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  // Avoid splitting a surrogate pair at the prefix edge.
  while (
    start > 0 &&
    start < before.length &&
    start < after.length &&
    before.charCodeAt(start - 1) >= 0xd800 &&
    before.charCodeAt(start - 1) <= 0xdbff &&
    after.charCodeAt(start) >= 0xdc00 &&
    after.charCodeAt(start) <= 0xdfff
  ) {
    start -= 1;
  }
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  // Avoid splitting a surrogate pair at the suffix edge: when the last
  // replaced unit is a high surrogate whose low half was counted as common
  // suffix, pull the whole pair back into the edit on both sides.
  while (
    endBefore > start &&
    endAfter > start &&
    endBefore < before.length &&
    endAfter < after.length &&
    before.charCodeAt(endBefore - 1) >= 0xd800 &&
    before.charCodeAt(endBefore - 1) <= 0xdbff &&
    before.charCodeAt(endBefore) >= 0xdc00 &&
    before.charCodeAt(endBefore) <= 0xdfff &&
    after.charCodeAt(endAfter - 1) >= 0xd800 &&
    after.charCodeAt(endAfter - 1) <= 0xdbff &&
    after.charCodeAt(endAfter) >= 0xdc00 &&
    after.charCodeAt(endAfter) <= 0xdfff
  ) {
    endBefore += 1;
    endAfter += 1;
  }
  return [{ range: { start, end: endBefore }, text: after.slice(start, endAfter) }];
}

/** CodeMirror 6 editor with live preview, IME gating, and cursor echo. */ export function CodeMirrorEditor({ value, snapshot, shouldUseNativeCursor, editable = true, ariaLabel, testId, onGuiEdits, onSelectionChange, initialSelection, externalCursor, livePreview = false, resolveImage, preferences = DEFAULT_EDITOR_PREFERENCES, vimMode = "insert", allowTextInput = true, focusRequest = 0, onEditorMenu, aiBaseline = null }: Props) {
  const { t, language } = useI18n();
  const languageRef = useRef(language);
  languageRef.current = language;
  const translatorRef = useRef(t);
  translatorRef.current = t;
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editableRef = useRef(new Compartment());
  const liveRef = useRef(new Compartment());
  const appearanceRef = useRef(new Compartment());
  const accessibilityRef = useRef(new Compartment());
  const aiDiffRef = useRef(new Compartment());
  const syncing = useRef(false);
  const composing = useRef(false);
  const printableKey = useRef<string | undefined>(undefined);
  const preComposition = useRef<string | null>(null);
  const preCompositionSelection = useRef<EditorSelection | null>(null);
  const compositionNativeCursor = useRef(false);
  const allowTextInputRef = useRef(allowTextInput);
  allowTextInputRef.current = allowTextInput;
  const callbacks = useRef({ onGuiEdits, onSelectionChange, shouldUseNativeCursor, onEditorMenu });
  callbacks.current = { onGuiEdits, onSelectionChange, shouldUseNativeCursor, onEditorMenu };
  const valueRef = useRef(value);
  valueRef.current = value;
  const editableRefValue = useRef(editable);
  editableRefValue.current = editable;

  // Widget callbacks stay fresh without rebuilding the editor: checkbox and
  // cell commits always read the latest props through this getter.
  const resolveImageRef = useRef(resolveImage);
  resolveImageRef.current = resolveImage;
  /** Build fresh live-preview callbacks reading latest props through refs. */
  const getLiveCallbacks = useCallback((): LivePreviewCallbacks => {
    return {
      /** Forward widget edits to the current GUI handler. */
      onGuiEdits: (edits) => callbacks.current.onGuiEdits?.(edits, viewRef.current?.state.doc.toString() ?? valueRef.current),
      resolveImage: resolveImageRef.current,
      translator: translatorRef.current,
      language: languageRef.current,
      /** Move the editor cursor into a source span and focus it. */
      focusSource: (from, to) => {
        const view = viewRef.current;
        if (!view) return;
        const len = view.state.doc.length;
        const anchor = Math.min(Math.max(0, from), len);
        const head = Math.min(Math.max(0, to), len);
        view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
        view.focus();
      },
    };
  }, []);

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: valueRef.current,
        selection: initialSelection ? { anchor: initialSelection.anchor, head: initialSelection.head } : undefined,
        extensions: [
          // Rust/Neovim retain CR as source text (ADR-0040). Keep identical
          // UTF-16 offsets and beforeText instead of normalizing CRLF or CR.
          EditorState.lineSeparator.of("\n"),
          markdown(),
          syntaxHighlighting(HighlightStyle.define([
            { tag: tags.heading, fontWeight: "600" },
            { tag: tags.strong, fontWeight: "600" },
            { tag: tags.emphasis, fontStyle: "italic" },
            { tag: [tags.link, tags.url], color: "var(--primary)" },
            { tag: [tags.meta, tags.processingInstruction], color: "var(--muted-foreground)" },
            { tag: tags.monospace, fontFamily: '"Cascadia Code", "Consolas", monospace' },
          ])),
          drawSelection({ cursorBlinkRate: 0 }),
          // Alt+drag draws a rectangle that Neovim receives as blockwise Visual; no other multi-cursor gestures.
          EditorState.allowMultipleSelections.of(true),
          EditorView.clickAddsSelectionRange.of(() => false),
          rectangularSelection(),
          crosshairCursor(),
          blockCursorWidth,
          appearanceRef.current.of([]),
          editableRef.current.of(EditorView.editable.of(editableRefValue.current)),
          liveRef.current.of([]),
          aiDiffRef.current.of(aiDiff(aiBaseline)),
          accessibilityRef.current.of(EditorView.contentAttributes.of({ "aria-label": ariaLabel, role: "textbox", tabindex: "0" })),
          EditorView.theme({
            "&": { backgroundColor: "transparent", fontSize: "14px", height: "100%" },
            ".cm-content": { fontFamily: "inherit", padding: "32px 0 80px" },
            ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--muted-foreground)" },
            ".cm-scroller": { overflow: "auto" },
            "&.cm-focused": { outline: "none" },
          }),
          EditorView.updateListener.of((update) => {
            if (syncing.current) return;
            // Preedit positions belong to uncommitted text, so neither edits
            // nor cursor reports may reach Neovim until composition ends.
            if (composing.current) return;
            if (update.docChanged) {
              const edits: TextEdit[] = [];
              update.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
                edits.push({ range: { start: from, end: to }, text: inserted.toString() });
              });
              if (edits.length > 0) {
                const sel = update.state.selection.main;
                const key = printableKey.current;
                printableKey.current = undefined;
                callbacks.current.onGuiEdits?.(edits, update.startState.doc.toString(), { anchor: sel.anchor, head: sel.head }, edits.length === 1 && edits[0].text === key ? key : undefined);
              }
            }
            // Text changes carry their own final cursor in the same queued
            // commit; selection-only gestures use the staged cursor path.
            if (update.selectionSet && !update.docChanged) {
              callbacks.current.onSelectionChange?.(reportedSelection(update.state.selection));
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    const dom = view.contentDOM;
    /** Capture printable keyboard identity before CodeMirror commits its text. */
    const onKeyDown = (event: KeyboardEvent) => {
      if (callbacks.current.onEditorMenu && (event.key === "ContextMenu" || event.key === "Menu" || (event.key === "F10" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey))) {
        event.preventDefault();
        event.stopPropagation();
        if (composing.current || event.isComposing || event.keyCode === 229) return;
        let caret: ReturnType<EditorView["coordsAtPos"]> = null;
        try { caret = view.coordsAtPos(view.state.selection.main.head); } catch { /* Hidden/offscreen views use their editor bounds. */ }
        const bounds = dom.getBoundingClientRect();
        callbacks.current.onEditorMenu({ x: caret?.left ?? bounds.left, y: caret?.bottom ?? bounds.top, keyboard: true,
          /** Restore the originating editor after keyboard-menu dismissal. */
          restoreFocus: () => view.focus(),
        });
        return;
      }
      printableKey.current = !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1 ? event.key : undefined;
    };
    /** Preserve native Visual selection and open only the editor's custom context menu. */
    const onContextMenu = (event: MouseEvent) => {
      if (!callbacks.current.onEditorMenu) return;
      event.preventDefault();
      if (composing.current) return;
      view.focus();
      if (view.state.selection.main.empty) {
        let at: number | null = null;
        try { at = view.posAtCoords({ x: event.clientX, y: event.clientY }); } catch { /* Keep the authoritative cursor when layout is unavailable. */ }
        if (at !== null) view.dispatch({ selection: { anchor: at, head: at } });
      }
      callbacks.current.onEditorMenu({ x: event.clientX, y: event.clientY, keyboard: false,
        /** Restore the originating editor after a native menu action. */
        restoreFocus: () => view.focus(),
      });
    };
    /** Preserve Vim Visual selection before the browser's right-button DOM selection update. */
    const onMenuMouseDown = (event: MouseEvent) => {
      if (event.button !== 2 || !callbacks.current.onEditorMenu) return;
      event.preventDefault();
      if (!composing.current) view.focus();
    };
    /** Prevent a key without a text transaction from tagging later input. */
    const onKeyUp = () => { printableKey.current = undefined; };
    /** Snapshot document and selection when IME composition starts. */
    const onStart = () => {
      printableKey.current = undefined;
      composing.current = true;
      preComposition.current = view.state.doc.toString();
      preCompositionSelection.current = { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head };
      compositionNativeCursor.current = callbacks.current.shouldUseNativeCursor?.() ?? false;
    };
    /** Commit composition once as a single range edit or revert disallowed input. */
    const onEnd = () => {
      if (!composing.current) return;
      composing.current = false;
      const before = preComposition.current ?? valueRef.current;
      const afterText = view.state.doc.toString();
      preComposition.current = null;
      if (!allowTextInputRef.current) {
        syncing.current = true;
        const prior = preCompositionSelection.current;
        const selection = prior ? { anchor: Math.min(prior.anchor, valueRef.current.length), head: Math.min(prior.head, valueRef.current.length) } : undefined;
        try { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: valueRef.current }, selection }); }
        finally { syncing.current = false; }
        return;
      }
      const edits = singleEditFromDiff(before, afterText);
      const sel = view.state.selection.main;
      if (edits && compositionNativeCursor.current) callbacks.current.onGuiEdits?.(edits, before, { anchor: sel.anchor, head: sel.head }, undefined, true);
      else if (edits) callbacks.current.onGuiEdits?.(edits, before, { anchor: sel.anchor, head: sel.head });
      else callbacks.current.onSelectionChange?.({ anchor: sel.anchor, head: sel.head });
    };
    dom.addEventListener("keydown", onKeyDown, true);
    dom.addEventListener("contextmenu", onContextMenu);
    dom.addEventListener("mousedown", onMenuMouseDown, true);
    dom.addEventListener("keyup", onKeyUp);
    dom.addEventListener("compositionstart", onStart);
    dom.addEventListener("compositionend", onEnd);
    return () => {
      dom.removeEventListener("keydown", onKeyDown, true);
      dom.removeEventListener("contextmenu", onContextMenu);
      dom.removeEventListener("mousedown", onMenuMouseDown, true);
      dom.removeEventListener("keyup", onKeyUp);
      dom.removeEventListener("compositionstart", onStart);
      dom.removeEventListener("compositionend", onEnd);
      view.destroy();
      viewRef.current = null;
    };
    // Mount once; document, selection, editable and translated labels sync below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: accessibilityRef.current.reconfigure(EditorView.contentAttributes.of({ "aria-label": ariaLabel, role: "textbox", tabindex: "0" })) });
  }, [ariaLabel]);

  useEffect(() => {
    if (focusRequest <= 0 || document.querySelector('[aria-modal="true"]')) return;
    viewRef.current?.focus();
  }, [focusRequest]);

  // Sync external snapshot text (undo, Vim sync, tab switch, GUI commit ack).
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    if (composing.current) return;
    syncing.current = true;
    try {
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
        selection: {
          anchor: Math.min(sel.anchor, value.length),
          head: Math.min(sel.head, value.length),
        },
      });
    } finally {
      syncing.current = false;
    }
  }, [value, snapshot]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: editableRef.current.reconfigure(EditorView.editable.of(editable)) });
  }, [editable]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: appearanceRef.current.reconfigure([
      ...(preferences.lineNumbers ? [lineNumbers()] : []),
      ...(preferences.wordWrap ? [EditorView.lineWrapping] : []),
      ...(preferences.highlightActiveLine ? [highlightActiveLine(), highlightActiveLineGutter()] : []),
      EditorView.theme({
        "&": { fontSize: `${preferences.fontSize}px` },
        ".cm-content": { lineHeight: String(preferences.lineHeight) },
      }),
    ]) });
  }, [preferences.fontSize, preferences.lineHeight, preferences.lineNumbers, preferences.wordWrap, preferences.highlightActiveLine, livePreview]);

  // Live widgets toggle without remounting the editor: reconfiguring the
  // compartment destroys removed widgets (abort + dispose run there).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: liveRef.current.reconfigure(livePreview ? createLivePreview(getLiveCallbacks) : []),
    });
  }, [livePreview, getLiveCallbacks, t, language]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: aiDiffRef.current.reconfigure(aiDiff(aiBaseline)) });
  }, [aiBaseline]);

  // Vim cursor echo: apply once per sequence token without disturbing
  // composition or the user's active selection gestures. The programmatic
  // dispatch is guarded, so it never echoes back through onSelectionChange.
  const appliedCursorSeq = useRef<number | null>(null);
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || !externalCursor) return;
    if (composing.current) return;
    if (appliedCursorSeq.current === externalCursor.seq) return;
    appliedCursorSeq.current = externalCursor.seq;
    const len = view.state.doc.length;
    const anchor = Math.min(Math.max(0, externalCursor.anchor), len);
    const head = Math.min(Math.max(0, externalCursor.head), len);
    const sel = view.state.selection.main;
    if (sel.anchor === anchor && sel.head === head) return;
    syncing.current = true;
    try {
      view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
    } finally {
      syncing.current = false;
    }
  }, [externalCursor]);

  return <div ref={host} data-testid={testId ?? "editor"} data-vim-mode={vimMode} data-live-preview={livePreview} data-readonly={!editable} style={{ "--editor-font-size": `${preferences.fontSize}px`, "--editor-line-height": preferences.lineHeight } as CSSProperties} aria-label={ariaLabel} className="marxen-editor h-full min-h-0 flex-1 overflow-hidden" />;
}

