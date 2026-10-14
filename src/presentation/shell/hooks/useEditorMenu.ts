import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorContext } from "../../../contracts/contracts";
import type { EditorAction } from "../../../application/ports";
import type { FormatKind } from "../../../domain/markdown-gui";
import { StaleResync, workspaceErrorText } from "../../../domain/document-errors";
import { localizedFailure } from "../../../domain/localization";
import type { LocalizedText } from "../../../contracts/localization";
import type { EditorMenuPoint } from "../../editor/EditorMenu";
import type { DocumentSession } from "./useDocumentSession";

interface MenuState { point: EditorMenuPoint; context: EditorContext | null; popup: boolean }
interface Args {
  session: DocumentSession;
  desktop: boolean;
  /** Surface native guard failures through the existing notification owner. */
  notify: (message: LocalizedText | null, kind?: "error") => void;
}

/** Capture native menu state and act through existing serialized document ports. */
export function useEditorMenu({ session, desktop, notify }: Args) {
  const [state, setState] = useState<MenuState | null>(null);
  const sequence = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  /** Close one menu and optionally return focus to its originating editor. */
  const dismiss = useCallback((restoreFocus = true) => {
    sequence.current += 1;
    if (restoreFocus) stateRef.current?.point.restoreFocus();
    setState(null);
  }, []);
  /** Fetch native selection/mappings after prior staged cursor updates finish. */
  const open = useCallback(async (point: EditorMenuPoint, popup = false) => {
    const id = session.activeRef.current;
    if (!id) return;
    const ticket = ++sequence.current;
    const generation = session.currentSelectionGen(id);
    if (!desktop || !session.registry) { if (!popup) setState({ point, context: null, popup }); return; }
    try {
      const context = await session.registry.fetchEditorContext(id);
      if (ticket !== sequence.current || !session.isSelectionGenCurrent(id, generation) || session.activeRef.current !== id) return;
      if (popup && (!context.presentation.selectionToolbar || context.cursor.anchor === context.cursor.head)) return;
      setState({ point, context, popup });
    } catch (cause) { if (!popup) { if (cause instanceof StaleResync) session.sayStale(cause.snapshot); else notify(localizedFailure(cause, workspaceErrorText), "error"); } }
  }, [desktop, session, notify]);
  /** Run one captured native clipboard/history action without retrying stale selections. */
  const act = useCallback(async (action: EditorAction) => {
    const restore = stateRef.current?.point.restoreFocus;
    const cursor = stateRef.current?.context?.cursor;
    if (!cursor || !session.registry) return;
    const generation = session.bumpSelectionGen(cursor.documentId);
    try {
      session.mergeSnapshot(await session.registry.editorAction(cursor, action));
      await session.refreshModeCursor(cursor.documentId, generation);
    } catch (cause) { if (cause instanceof StaleResync) session.sayStale(cause.snapshot); else notify(localizedFailure(cause, workspaceErrorText), "error"); await session.refreshModeCursor(cursor.documentId, generation); }
    finally { dismiss(false); restore?.(); }
  }, [session, notify, dismiss]);
  /** Format only the revision-bound native selection captured by the menu. */
  const format = useCallback(async (kind: FormatKind) => {
    const restore = stateRef.current?.point.restoreFocus;
    const cursor = stateRef.current?.context?.cursor;
    if (!cursor || !session.registry) return;
    const current = session.docsRef.current[cursor.documentId];
    if (!current || current.revision !== cursor.revision) { dismiss(); return; }
    const generation = session.bumpSelectionGen(cursor.documentId);
    try {
      session.mergeSnapshot(await session.registry.formatEditorSelection(cursor, current.text, kind));
      await session.refreshModeCursor(cursor.documentId, generation);
    } catch (cause) { if (cause instanceof StaleResync) session.sayStale(cause.snapshot); else notify(localizedFailure(cause, workspaceErrorText), "error"); }
    finally { dismiss(false); restore?.(); }
  }, [session, dismiss, notify]);
  const selected = session.activeId ? session.selections[session.activeId] : undefined;
  const activeRevision = session.active?.revision;
  useEffect(() => {
    if (stateRef.current?.context && (stateRef.current.context.cursor.documentId !== session.activeId || stateRef.current.context.cursor.revision !== activeRevision)) dismiss(false);
    if (!desktop || !selected || selected.anchor === selected.head || !["visual", "visual_line"].includes(session.vimMode)) {
      if (stateRef.current?.popup) dismiss(false);
      return;
    }
    const editor = document.querySelector<HTMLElement>('[data-testid="editor-primary"] .cm-content');
    if (!editor) return;
    const bounds = editor.getBoundingClientRect();
    void open({ x: bounds.left + 16, y: bounds.top + 8, keyboard: false,
      /** Restore the editor only after an explicit popup action. */
      restoreFocus: () => editor.focus(),
    }, true);
    // Capture the user gesture only; session callback identities do not create new popups.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop, session.activeId, selected?.anchor, selected?.head, session.vimMode, activeRevision]);
  return { state, open, dismiss, act, format };
}
