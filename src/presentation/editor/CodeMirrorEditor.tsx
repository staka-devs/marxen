import { useCallback, useEffect, useRef, type CSSProperties } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, lineNumbers, drawSelection, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { TextEdit } from "../../contracts/contracts";
import { createLivePreview, type LivePreviewCallbacks } from "./livePreview";
import type { ImageResolver } from "../../domain/image-sources";
import { DEFAULT_EDITOR_PREFERENCES, type EditorPreferences } from "../../domain/editor-preferences";

export interface EditorSelection {
  anchor: number;
  head: number;
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
  value: string;
  editable?: boolean;
  ariaLabel: string;
  testId?: string;
  /** Emit committed document changes as wire range edits. */
  onGuiEdits?: (edits: TextEdit[]) => void;
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

/** CodeMirror 6 editor with live preview, IME gating, and cursor echo. */ export function CodeMirrorEditor({ value, editable = true, ariaLabel, testId, onGuiEdits, onSelectionChange, initialSelection, externalCursor, livePreview = false, resolveImage, preferences = DEFAULT_EDITOR_PREFERENCES, vimMode = "insert", allowTextInput = true, focusRequest = 0 }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editableRef = useRef(new Compartment());
  const liveRef = useRef(new Compartment());
  const appearanceRef = useRef(new Compartment());
  const syncing = useRef(false);
  const composing = useRef(false);
  const preComposition = useRef<string | null>(null);
  const preCompositionSelection = useRef<EditorSelection | null>(null);
  const compositionAllowed = useRef(true);
  const allowTextInputRef = useRef(allowTextInput);
  allowTextInputRef.current = allowTextInput;
  const callbacks = useRef({ onGuiEdits, onSelectionChange });
  callbacks.current = { onGuiEdits, onSelectionChange };
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
      onGuiEdits: (edits) => callbacks.current.onGuiEdits?.(edits),
      resolveImage: resolveImageRef.current,
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
          appearanceRef.current.of([]),
          editableRef.current.of(EditorView.editable.of(editableRefValue.current)),
          liveRef.current.of([]),
          EditorView.contentAttributes.of({ "aria-label": ariaLabel, role: "textbox", tabindex: "0" }),
          EditorView.theme({
            "&": { backgroundColor: "transparent", fontSize: "14px", height: "100%" },
            ".cm-content": { fontFamily: "inherit", padding: "32px 0 80px" },
            ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--muted-foreground)" },
            ".cm-scroller": { overflow: "auto" },
            "&.cm-focused": { outline: "none" },
          }),
          EditorView.updateListener.of((update) => {
            if (syncing.current) return;
            if (update.selectionSet) {
              const sel = update.state.selection.main;
              callbacks.current.onSelectionChange?.({ anchor: sel.anchor, head: sel.head });
            }
            if (!update.docChanged) return;
            if (composing.current) {
              // Buffer preedit: commit exactly once on compositionend.
              return;
            }
            // Map the CodeMirror transaction to wire range edits without
            // reserializing: one TextEdit per change range.
            const edits: TextEdit[] = [];
            update.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
              edits.push({ range: { start: from, end: to }, text: inserted.toString() });
            });
            if (edits.length > 0) callbacks.current.onGuiEdits?.(edits);
          }),
        ],
      }),
    });
    viewRef.current = view;
    const dom = view.contentDOM;
    /** Snapshot document and selection when IME composition starts. */
    const onStart = () => {
      composing.current = true;
      preComposition.current = view.state.doc.toString();
      preCompositionSelection.current = { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head };
      compositionAllowed.current = allowTextInputRef.current;
    };
    /** Commit composition once as a single range edit or revert disallowed input. */
    const onEnd = () => {
      if (!composing.current) return;
      composing.current = false;
      const before = preComposition.current ?? valueRef.current;
      const afterText = view.state.doc.toString();
      preComposition.current = null;
      if (!compositionAllowed.current && !allowTextInputRef.current) {
        syncing.current = true;
        const prior = preCompositionSelection.current;
        const selection = prior ? { anchor: Math.min(prior.anchor, valueRef.current.length), head: Math.min(prior.head, valueRef.current.length) } : undefined;
        try { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: valueRef.current }, selection }); }
        finally { syncing.current = false; }
        return;
      }
      const edits = singleEditFromDiff(before, afterText);
      if (edits) callbacks.current.onGuiEdits?.(edits);
    };
    dom.addEventListener("compositionstart", onStart);
    dom.addEventListener("compositionend", onEnd);
    return () => {
      dom.removeEventListener("compositionstart", onStart);
      dom.removeEventListener("compositionend", onEnd);
      view.destroy();
      viewRef.current = null;
    };
    // Mount once; value/editable sync below. ariaLabel/testId are static per pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (focusRequest <= 0 || document.querySelector('[aria-modal="true"]')) return;
    viewRef.current?.focus();
  }, [focusRequest]);

  // Sync external snapshot text (undo, Vim sync, tab switch, GUI commit ack).
  useEffect(() => {
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
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: editableRef.current.reconfigure(EditorView.editable.of(editable)) });
  }, [editable]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: appearanceRef.current.reconfigure([
      ...(preferences.lineNumbers && !livePreview ? [lineNumbers()] : []),
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
  }, [livePreview, getLiveCallbacks]);

  // Vim cursor echo: apply once per sequence token without disturbing
  // composition or the user's active selection gestures. The programmatic
  // dispatch is guarded, so it never echoes back through onSelectionChange.
  const appliedCursorSeq = useRef<number | null>(null);
  useEffect(() => {
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

