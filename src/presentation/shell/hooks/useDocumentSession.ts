import { localizedFailure } from "../../../domain/localization";
import type { LabelKey, LocalizedText } from "../../../contracts/localization";
import { useI18n } from "../../i18n/I18nProvider";
// Revision-aware document session for the shell (presentation).
//
// Owns open documents, tabs, selections, cursor echoes, and Vim mode display
// with serial registry access. Stale revisions never retry blindly: the fresh
// snapshot replaces the view, and generation fencing keeps late async
// completions from rewinding newer gestures. All native access arrives via
// injected ports, so this hook never imports infrastructure directly.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditorSelection, ExternalCursor } from "../../editor/CodeMirrorEditor";
import type { DocumentSnapshot, TextEdit, YankCopy, RootScope, WorkspaceInfo, VimCommandLine, VimCompletion, QuickfixList, ExReport, SearchCount } from "../../../contracts/contracts";
import { sameRoot } from "../../../domain/document-location";
import { imageTabId, parseImageTabId } from "../../../domain/workspace-roots";
import { SAMPLE_WORKSPACE } from "../../../domain/workspace-content";
import { StaleResync, workspaceErrorText } from "../../../domain/document-errors";
import { isImagePath, isMarkdownPath } from "../../../domain/workspace-files";
import { applySnapshot, docFromOpen, type OpenDoc } from "../../../application/document/document-helpers";
import { COPY_LABELS } from "../../../domain/clipboard-text";
import type { ClipboardGateway, DocumentGateway, WorkspaceGateway } from "../../../application/ports";
import type { NoticeKind } from "../../workspace/Notifications";

/** Injected ports for the document session. */
export interface DocumentSessionArgs {
  /** True on desktop; the browser demo stays read-only over static samples. */
  desktop: boolean;
  /** Raw registry gateway, or undefined when the transport is unavailable. */
  documentGateway?: DocumentGateway;
  /** Workspace file gateway for open and close operations. */
  workspaceGateway?: WorkspaceGateway;
  /** Clipboard gateway for yank presentation through Rust. */
  clipboardGateway?: ClipboardGateway;
  /** Surface a notice without importing shell state. */
  notify: (message: LocalizedText | null, kind?: NoticeKind) => void;
  /** Run an application command requested by the user's native Vim mapping. */
  onVimCommand?: (command: string) => void;
}

/** Document session state and revision-aware operations. */
export interface DocumentSession {
  /** Serial registry when desktop with a gateway; null stays read-only. */
  registry: DocumentGateway | null;
  /** Open documents keyed by document ID. */
  docs: Record<string, OpenDoc>;
  /** Replace the open documents map. */
  setDocs: React.Dispatch<React.SetStateAction<Record<string, OpenDoc>>>;
  /** Live ref mirroring the docs map for async callbacks. */
  docsRef: React.MutableRefObject<Record<string, OpenDoc>>;
  /** Open tab IDs in order, including `image:` tabs. */
  tabs: string[];
  /** Replace the open tab list. */
  setTabs: React.Dispatch<React.SetStateAction<string[]>>;
  /** Active tab ID, or null when nothing is open. */
  activeId: string | null;
  /** Activate a tab by ID. */
  setActiveId: React.Dispatch<React.SetStateAction<string | null>>;
  /** Live ref mirroring the active tab ID. */
  activeRef: React.MutableRefObject<string | null>;
  /** Active document, or null when nothing is open. */
  active: OpenDoc | null;
  /** Active image path for `image:` tabs, if any. */
  activeImage: string | undefined;
  /** Whether the active document renders as Markdown. */
  activeIsMarkdown: boolean;
  /** Image tab paths keyed by `image:` tab ID. */
  imageTabs: Record<string, string>;
  /** Replace the image tab map. */
  setImageTabs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  /** GUI selections keyed by document ID. */
  selections: Record<string, EditorSelection>;
  /** Replace the selections map. */
  setSelections: React.Dispatch<React.SetStateAction<Record<string, EditorSelection>>>;
  /** Shell cursor echoes keyed by document ID. */
  cursorEcho: Record<string, ExternalCursor>;
  /** Echo a cursor with a fresh sequence token. */
  echoCursor: (id: string, anchor: number, head: number) => void;
  /** Current Vim mode label for display. */
  vimMode: string;
  /** Native Ex/search input with its actual cursor position. */
  commandLine: VimCommandLine | null;
  /** Native Tab-completion candidates, if Neovim is showing them. */
  completion: VimCompletion | null;
  /** Fresh quickfix results from a command-line search, sticky until replaced. */
  quickfix: QuickfixList | null;
  /** Discard the displayed quickfix results. */
  clearQuickfix: () => void;
  /** Executed command-line reports for the search tab. */
  exReports: ExReport[];
  /** Current `/` match position, if Neovim reported one. */
  searchCount: SearchCount | null;
  /** Native command output or error. */
  vimMessage: string | null;
  /** Replace the Vim mode display. */
  setVimMode: React.Dispatch<React.SetStateAction<string>>;
  /** Live ref mirroring the Vim mode for event-time routing. */
  vimModeRef: React.MutableRefObject<string>;
  /** Recent Vim keystrokes for the footer display. */
  vimKeys: string;
  /** Append to the recent Vim keystrokes display. */
  setVimKeys: React.Dispatch<React.SetStateAction<string>>;
  /** Optimistic caret positions keyed by document ID. */
  caretRef: React.MutableRefObject<Record<string, number>>;
  /** External-change markers keyed by document ID. */
  externalByDoc: Record<string, { path: string; deleted: boolean }>;
  /** Replace the external-change markers. */
  setExternalByDoc: React.Dispatch<React.SetStateAction<Record<string, { path: string; deleted: boolean }>>>;
  /** Document ID with an unresolved save conflict, if any. */
  conflictDoc: string | null;
  /** Replace the conflict marker. */
  setConflictDoc: React.Dispatch<React.SetStateAction<string | null>>;
  /** Document ID awaiting a dirty-close decision, if any. */
  closeDecision: string | null;
  /** Replace the dirty-close decision. */
  setCloseDecision: React.Dispatch<React.SetStateAction<string | null>>;
  /** Document ID with copy formats ready, if any. */
  copyReady: string | null;
  /** Replace the copy-ready indicator. */
  setCopyReady: React.Dispatch<React.SetStateAction<string | null>>;
  /** Bump the selection generation for a document. */
  bumpSelectionGen: (id: string) => number;
  /** Read the current selection generation for a document without bumping. */
  currentSelectionGen: (id: string) => number;
  /** Check whether a generation ticket is still current. */
  isSelectionGenCurrent: (id: string, gen: number) => boolean;
  /** Replace the view with a stale-rejected snapshot and notice once. */
  sayStale: (snapshot: DocumentSnapshot) => void;
  /** Merge an authoritative snapshot keeping newer-or-equal revisions. */
  mergeSnapshot: (snapshot: DocumentSnapshot) => void;
  /** Refresh native mode and cursor gated by generation tickets. */
  refreshModeCursor: (id: string, gen?: number) => Promise<void>;
  /** Refresh mode after a selection preserving Insert/Replace ranges. */
  refreshModeAfterSelection: (id: string, reported: EditorSelection, gen: number) => Promise<void>;
  /** Stage a GUI selection serially then refresh mode without races. */
  handleSelection: (id: string, selection: EditorSelection) => void;
  /** Jump to offsets with an immediate cursor report. */
  jumpToOffset: (id: string, anchor: number, head: number) => Promise<void>;
  /** Copy a yank via Rust and clear the ready indicator. */
  writeYankToClipboard: (copy: YankCopy, id: string) => Promise<void>;
  /** Insert committed text after a pending native cursor transition. */
  applyNativeText: (id: string, text: string) => Promise<void>;
  /** Apply GUI edits serially with stale resync instead of retry. */
  applyEdits: (id: string, edits: TextEdit[], beforeText?: string, selection?: EditorSelection, key?: string) => Promise<void>;
  /** Undo through the native stack for the active document. */
  handleUndo: () => Promise<void>;
  /** Redo through the native stack for the active document. */
  handleRedo: () => Promise<void>;
  /** Save at the live revision, flagging conflicts without losing text. */
  handleSave: () => Promise<void>;
  /** Reload from disk clearing external markers. */
  handleReload: () => Promise<void>;
  /** Close a tab, prompting for dirty documents via close dialog. */
  closeTab: (id: string) => Promise<void>;
  /** Move an unedited document's file to the trash and drop its tab; throws when refused. */
  trashDocument: (id: string, revision: number) => Promise<void>;
  /** Resolve the dirty-close dialog with save, discard, or cancel. */
  resolveCloseDecision: (action: "save" | "discard" | "cancel") => Promise<void>;
  /** Open a file by path through the registry with cursor refresh. */
  openFile: (path: string, scope?: RootScope) => Promise<void>;
  /** Register the available native incarnations before accepting asynchronous opens. */
  configureRoots: (roots: WorkspaceInfo[]) => void;
  /** Resolve the captured owner of an image tab. */
  imageScope: (id: string) => RootScope | undefined;
  /** Static demo documents for the browser, never authoritative. */
  demo: Record<string, OpenDoc>;
}

/**
 * Own the shell document session: docs, tabs, selections, cursors, and mode.
 *
 * Returns state plus revision-aware operations; sibling hooks for Vim
 * routing, workspace lifecycle, images, and AI staging compose through the
 * returned refs and callbacks with explicit ports.
 */
export function useDocumentSession(args: DocumentSessionArgs): DocumentSession {
  const { message } = useI18n();
  const { desktop, documentGateway, workspaceGateway, clipboardGateway, notify } = args;
  const setNotice = notify;
  /** Serial registry when desktop with an injected gateway; null stays read-only. */
  const registry = desktop && documentGateway ? documentGateway : null;

  // Demo samples for the read-only browser (never authoritative).
  /**
   * Static demo documents for the browser, keyed by path with revision 0.
   *
   * Never authoritative; desktop reads every document through the registry.
   */
  const demo = useMemo(() => {
    const docs: Record<string, OpenDoc> = {};
    for (const file of SAMPLE_WORKSPACE) {
      docs[file.path] = { documentId: file.path, path: file.path, text: file.text, revision: 0, dirty: false };
    }
    return docs;
  }, []);

  const [docs, setDocs] = useState<Record<string, OpenDoc>>(desktop ? {} : demo);
  const [imageTabs, setImageTabs] = useState<Record<string, string>>({});
  const [tabs, setTabs] = useState<string[]>(() => (desktop ? [] : [SAMPLE_WORKSPACE[0].path]));
  const [activeId, setActiveId] = useState<string | null>(() => (desktop ? null : SAMPLE_WORKSPACE[0].path));
  const [selections, setSelections] = useState<Record<string, EditorSelection>>({});
  const [cursorEcho, setCursorEcho] = useState<Record<string, ExternalCursor>>({});
  const [vimMode, setVimMode] = useState("normal");
  const [commandLine, setCommandLine] = useState<VimCommandLine | null>(null);
  /** Native completion popup mirrored from the latest mode update. */
  const [completion, setCompletion] = useState<VimCompletion | null>(null);
  /** Latest quickfix list from command-line search, kept until replaced. */
  const [quickfix, setQuickfix] = useState<QuickfixList | null>(null);
  /** Discard the displayed quickfix results. */
  const clearQuickfix = useCallback(() => setQuickfix(null), []);
  /** Executed command-line reports, newest last, capped for display. */
  const [exReports, setExReports] = useState<ExReport[]>([]);
  /** Latest reported `/` match position. */
  const [searchCount, setSearchCount] = useState<SearchCount | null>(null);
  const [vimMessage, setVimMessage] = useState<string | null>(null);
  const vimCommand = useRef(args.onVimCommand);
  vimCommand.current = args.onVimCommand;
  const [vimKeys, setVimKeys] = useState("");
  const [externalByDoc, setExternalByDoc] = useState<Record<string, { path: string; deleted: boolean }>>({});
  const [conflictDoc, setConflictDoc] = useState<string | null>(null);
  const [closeDecision, setCloseDecision] = useState<string | null>(null);
  const [copyReady, setCopyReady] = useState<string | null>(null);
  const roots = useRef<WorkspaceInfo[]>([]);
  /** Replace available incarnations synchronously to fence removed-root completions. */
  const configureRoots = useCallback((value: WorkspaceInfo[]) => { roots.current = value; }, []);
  /** Resolve a qualified image tab without guessing its owner from the active folder. */
  const imageScope = useCallback((id: string) => roots.current.find((root) => root.scope.rootId === parseImageTabId(id)?.rootId)?.scope, []);

  const docsRef = useRef(docs);
  docsRef.current = docs;
  const pendingGui = useRef<Record<string, number>>({});
  const deferredSnapshots = useRef<Record<string, DocumentSnapshot>>({});
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  // Dedicated cursor sequence: every echo gets a fresh token so navigation
  // without text change is never suppressed by revision equality.
  const cursorSeq = useRef(0);
  /** Echo a cursor with a fresh sequence token for navigation without edits. */
  const echoCursor = useCallback((id: string, anchor: number, head: number) => {
    cursorSeq.current += 1;
    const seq = cursorSeq.current;
    setCursorEcho((prev) => ({ ...prev, [id]: { anchor, head, seq } }));
  }, []);
  const vimModeRef = useRef(vimMode);
  vimModeRef.current = vimMode;
  // Selection generation per document: every selection gesture, explicit jump,
  // and queued edit/key bumps it. Async completions (cursor
  // refreshes, queued-edit collapses) capture it on entry and skip their
  // selection/echo writes when a newer gesture landed meanwhile, so a late
  // refresh can never reset a newer range. In Insert/Replace the exact GUI
  // range just reported stays authoritative because the native cursor there
  // is a single recomputed point that cannot hold it.
  const selectionGenRef = useRef<Record<string, number>>({});
  /** Bump selection generation for gating late async completions. */
  const bumpSelectionGen = useCallback((id: string): number => {
    const next = (selectionGenRef.current[id] ?? 0) + 1;
    selectionGenRef.current[id] = next;
    return next;
  }, []);
  /** Check a generation ticket is still current before writing selections. */
  const isSelectionGenCurrent = useCallback((id: string, gen: number): boolean => {
    return (selectionGenRef.current[id] ?? 0) === gen;
  }, []);
  /** Read the current selection generation for a document without bumping. */
  const currentSelectionGen = useCallback((id: string): number => {
    return selectionGenRef.current[id] ?? 0;
  }, []);
  // Optimistic caret: GUI edits always collapse, so bursts advance a single
  // collapsed caret; a fresh noncollapsed selection is consumed once by the
  // first key and then collapses. Corrected by cursor echoes and refreshes.
  const caretRef = useRef<Record<string, number>>({});

  const active: OpenDoc | null = activeId ? (docs[activeId] ?? null) : null;
  const activeImage = activeId ? imageTabs[activeId] : undefined;
  const activeIsMarkdown = active !== null && isMarkdownPath(active.path);

  /** Replace the view with a stale-rejected snapshot and notice once. */
  const sayStale = useCallback((snapshot: DocumentSnapshot) => {
    const id = snapshot.documentId;
    setDocs((prev) => {
      const doc = prev[id];
      if (!doc || snapshot.revision < doc.revision) return prev;
      return { ...prev, [id]: applySnapshot(doc, snapshot) };
    });
    setNotice(localizedFailure(new StaleResync(snapshot), workspaceErrorText), "error");
  }, [notify]);

  /** Merge an authoritative snapshot keeping newer-or-equal revisions. */
  const mergeSnapshot = useCallback(
    (snapshot: DocumentSnapshot) => {
      if (registry) registry.noteSnapshot(snapshot);
      if ((pendingGui.current[snapshot.documentId] ?? 0) > 0) {
        const prior = deferredSnapshots.current[snapshot.documentId];
        if (!prior || snapshot.revision >= prior.revision) deferredSnapshots.current[snapshot.documentId] = snapshot;
        return;
      }
      setDocs((prev) => {
        const doc = prev[snapshot.documentId];
        if (!doc || snapshot.revision < doc.revision) return prev;
        return { ...prev, [snapshot.documentId]: applySnapshot(doc, snapshot) };
      });
    },
    [registry],
  );

  /** Refresh native mode and cursor gated by generation tickets. */
  const refreshModeCursor = useCallback(
    async (id: string, gen?: number) => {
      if (!registry) return;
      // A generation captured at the user gesture (or, by default, now):
      // async completions whose generation went stale never overwrite a
      // newer selection, echo, or mode display.
      const ticket = gen ?? selectionGenRef.current[id] ?? 0;
      let nativeMode: string | undefined;
      try {
        const mode = await registry.fetchMode(id);
        for (const command of mode.commands ?? []) vimCommand.current?.(command);
        if (!isSelectionGenCurrent(id, ticket)) return;
        nativeMode = mode.mode;
        if (activeRef.current === id) {
          setVimMode(mode.mode);
          setCommandLine(mode.commandLine ?? null);
          setCompletion(mode.completion ?? null);
          if (mode.quickfix) setQuickfix(mode.quickfix);
          if (mode.exReport) {
            const report = mode.exReport;
            setExReports((previous) => [...previous.slice(-4), report]);
          }
          if (mode.searchCount) setSearchCount(mode.searchCount);
          setVimMessage(mode.message ?? null);
        }
      } catch {
        // Best-effort display only.
      }
      try {
        const cursor = await registry.fetchCursor(id);
        if (!isSelectionGenCurrent(id, ticket)) return;
        setSelections((prev) => ({ ...prev, [id]: { anchor: cursor.anchor, head: cursor.head } }));
        caretRef.current[id] = cursor.head;
        echoCursor(id, cursor.anchor, cursor.head);
        if (nativeMode !== undefined && activeRef.current === id) setVimMode(nativeMode);
      } catch {
        // Best-effort display only.
      }
    },
    [registry, echoCursor, isSelectionGenCurrent],
  );

  /**
   * Follow-up for a just-reported GUI selection: refresh the actual mode, but
   * preserve the exact reported range while in Insert/Replace (the native
   * cursor there recomputes to a single point that cannot hold a range).
   * Outside insert the fetched native selection (a real Visual install) wins
   * and its mode is exposed.
   */
  /** Refresh mode after selection preserving Insert/Replace ranges. */
  const refreshModeAfterSelection = useCallback(
    async (id: string, reported: EditorSelection, gen: number) => {
      if (!registry) return;
      let mode: string;
      try {
        const update = await registry.fetchMode(id);
        for (const command of update.commands ?? []) vimCommand.current?.(command);
        if (!isSelectionGenCurrent(id, gen)) return;
        mode = update.mode;
        if (activeRef.current === id) {
          setVimMode(mode); setCommandLine(update.commandLine ?? null); setCompletion(update.completion ?? null);
          if (update.quickfix) setQuickfix(update.quickfix);
          if (update.exReport) {
            const report = update.exReport;
            setExReports((previous) => [...previous.slice(-4), report]);
          }
          if (update.searchCount) setSearchCount(update.searchCount);
          setVimMessage(update.message ?? null);
        }
      } catch {
        return;
      }
      // The GUI keeps drawing its Alt+drag rectangle; Rust never reports block corners as a range.
      if (mode === "visual_block" && reported.block) return;
      if (mode === "insert" || mode === "replace") {
        if (!isSelectionGenCurrent(id, gen)) return;
        setSelections((prev) => ({ ...prev, [id]: { anchor: reported.anchor, head: reported.head } }));
        caretRef.current[id] = reported.head;
        echoCursor(id, reported.anchor, reported.head);
        return;
      }
      await refreshModeCursor(id, gen);
    },
    [registry, echoCursor, isSelectionGenCurrent, refreshModeCursor],
  );

  /** Stage a GUI selection serially then refresh mode without races. */
  const handleSelection = useCallback(
    (id: string, selection: EditorSelection) => {
      const gen = bumpSelectionGen(id);
      setSelections((prev) => ({ ...prev, [id]: selection }));
      caretRef.current[id] = selection.head;
      if (!registry) return;
      // Serialized and coalesced inside the client: rapid gestures send only
      // the latest selection and never race mutations or echo back. Mouse
      // gestures keep their anchor; the follow-up refresh preserves the
      // exact range in Insert/Replace and exposes real Visual otherwise.
      void registry
        .stageCursor(id, selection.anchor, selection.head, selection.block)
        .then(() => {
          void refreshModeAfterSelection(id, selection, gen);
        })
        .catch(() => undefined);
    },
    [registry, bumpSelectionGen, refreshModeAfterSelection],
  );

  /** Jump to offsets with immediate cursor report at execution revision. */
  const jumpToOffset = useCallback(
    async (id: string, anchor: number, head: number) => {
      bumpSelectionGen(id);
      const gen = selectionGenRef.current[id] ?? 0;
      echoCursor(id, anchor, head);
      if (!registry) return;
      if (!docsRef.current[id]) return;
      try {
        const cursor = await registry.reportCursorNow(id, anchor, head);
        if (!isSelectionGenCurrent(id, gen)) return;
        setSelections((prev) => ({ ...prev, [id]: { anchor: cursor.anchor, head: cursor.head } }));
        echoCursor(id, cursor.anchor, cursor.head);
        await refreshModeCursor(id, gen);
      } catch {
        // Best-effort navigation; the editor keeps its own selection.
      }
    },
    [registry, echoCursor, refreshModeCursor, bumpSelectionGen, isSelectionGenCurrent],
  );

  /** Flush the newest deferred native snapshot after the last GUI input settles. */
  const finishGuiInput = useCallback((id: string) => {
    pendingGui.current[id] -= 1;
    if (pendingGui.current[id] === 0) {
      const snapshot = deferredSnapshots.current[id];
      delete deferredSnapshots.current[id];
      if (snapshot) mergeSnapshot(snapshot);
    }
  }, [mergeSnapshot]);

  /** Reconcile rejected GUI input while preserving its actual validation error. */
  const recoverGuiInput = useCallback(async (id: string, cause: unknown, gen: number) => {
    if (cause instanceof StaleResync) mergeSnapshot(cause.snapshot);
    else {
      try { if (registry) mergeSnapshot(await registry.fetchSnapshot(id)); } catch { /* The original error remains the useful notice. */ }
    }
    await refreshModeCursor(id, gen);
    setNotice(localizedFailure(cause, workspaceErrorText), "error");
  }, [registry, mergeSnapshot, refreshModeCursor, notify]);

  /** Commit text at the native cursor when preceding keys have moved it. */
  const applyNativeText = useCallback(async (id: string, text: string) => {
    if (!registry || !docsRef.current[id] || text.length === 0) return;
    const gen = bumpSelectionGen(id);
    pendingGui.current[id] = (pendingGui.current[id] ?? 0) + 1;
    try {
      mergeSnapshot(await registry.insertNativeText(id, text));
      await refreshModeCursor(id, gen);
    } catch (cause) {
      await recoverGuiInput(id, cause, gen);
    } finally { finishGuiInput(id); }
  }, [registry, mergeSnapshot, refreshModeCursor, bumpSelectionGen, finishGuiInput, recoverGuiInput]);

  /** Copy a yank via Rust and clear the ready indicator. */
  const writeYankToClipboard = useCallback(async (copy: YankCopy, id: string) => {
    try {
      await clipboardGateway!.copyYank(copy, id);
      setNotice(message("{{value0}}をコピーしました。", { value0: message(COPY_LABELS[copy.format] as LabelKey) }));
    } finally {
      setCopyReady((ready) => ready === id ? null : ready);
    }
  }, [clipboardGateway, notify]);

  /** Apply GUI edits serially with stale resync instead of retry. */
  const applyEdits = useCallback(
    async (id: string, edits: TextEdit[], beforeText?: string, selection?: EditorSelection, key?: string) => {
      if (!registry) {
        setNotice(message("ブラウザ表示では編集できません。デスクトップで開いてください。"));
        return;
      }
      const current = docsRef.current[id];
      if (!current || edits.length === 0) return;
      const gen = bumpSelectionGen(id);
      if (selection) {
        setSelections((prev) => ({ ...prev, [id]: selection }));
        caretRef.current[id] = selection.head;
      }
      if (beforeText !== undefined) pendingGui.current[id] = (pendingGui.current[id] ?? 0) + 1;
      try {
        const request = { ...(current.location ? { location: current.location } : {}), documentId: id, baseRevision: current.revision };
        if (key !== undefined && beforeText !== undefined && edits.length === 1 && edits[0].text === key) {
          const decision = await registry.routeCharKey(id, key, edits[0].range, (copy) => writeYankToClipboard(copy, id), beforeText);
          mergeSnapshot(decision.snapshot);
          if (decision.action === "vim") await refreshModeCursor(id, gen);
        } else {
          const snapshot = beforeText === undefined
            ? await registry.applyEdits(request, edits)
            : await registry.applyGuiEdits(request, beforeText, edits, selection);
          mergeSnapshot(snapshot);
        }
      } catch (cause) {
        await recoverGuiInput(id, cause, gen);
      } finally {
        if (beforeText !== undefined) {
          finishGuiInput(id);
        }
      }
    },
    [registry, mergeSnapshot, sayStale, bumpSelectionGen, writeYankToClipboard, refreshModeCursor, finishGuiInput, recoverGuiInput],
  );

  /** Undo through the native stack for the active document. */
  const handleUndo = useCallback(async () => {
    if (!registry || !activeRef.current) {
      setNotice(message("ブラウザ表示では編集できません。デスクトップで開いてください。"));
      return;
    }
    const id = activeRef.current;
    const gen = bumpSelectionGen(id);
    try {
      mergeSnapshot(await registry.undo(id));
      await refreshModeCursor(id, gen);
    } catch (cause) {
      setNotice(localizedFailure(cause, workspaceErrorText), "error");
    }
  }, [registry, mergeSnapshot, refreshModeCursor, bumpSelectionGen, notify]);

  /** Redo through the native stack for the active document. */
  const handleRedo = useCallback(async () => {
    if (!registry || !activeRef.current) {
      setNotice(message("ブラウザ表示では編集できません。デスクトップで開いてください。"));
      return;
    }
    const id = activeRef.current;
    const gen = bumpSelectionGen(id);
    try {
      mergeSnapshot(await registry.redo(id));
      await refreshModeCursor(id, gen);
    } catch (cause) {
      setNotice(localizedFailure(cause, workspaceErrorText), "error");
    }
  }, [registry, mergeSnapshot, refreshModeCursor, bumpSelectionGen, notify]);

  /** Save at the live revision, flagging conflicts without losing text. */
  const handleSave = useCallback(async () => {
    if (!registry || !activeRef.current) {
      setNotice(message("ブラウザ表示では編集できません。デスクトップで開いてください。"));
      return;
    }
    const id = activeRef.current;
    const current = docsRef.current[id];
    if (!current) return;
    try {
      const result = await registry.save({ ...(current.location ? { location: current.location } : {}), documentId: id, baseRevision: current.revision });
      setDocs((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], revision: result.revision, dirty: result.dirty } } : prev));
      setConflictDoc((prev) => (prev === id ? null : prev));
      setNotice(message("保存しました。"), "success");
    } catch (cause) {
      if (cause instanceof StaleResync) {
        sayStale(cause.snapshot);
        return;
      }
      const record = cause as { code?: unknown };
      if (typeof record === "object" && record !== null && record.code === "conflict") {
        setConflictDoc(id);
      }
      setNotice(localizedFailure(cause, workspaceErrorText), "error");
    }
  }, [registry, sayStale, notify]);

  /** Reload from disk clearing external markers. */
  const handleReload = useCallback(async () => {
    if (!registry || !activeRef.current) {
      setNotice(message("ブラウザ表示では編集できません。デスクトップで開いてください。"));
      return;
    }
    const id = activeRef.current;
    const current = docsRef.current[id];
    if (!current) return;
    try {
      mergeSnapshot(await registry.reload({ ...(current.location ? { location: current.location } : {}), documentId: id, baseRevision: current.revision }));
      setExternalByDoc((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setNotice(message("最新のMarkdownに再読込しました。"));
    } catch (cause) {
      setNotice(localizedFailure(cause, workspaceErrorText), "error");
    }
  }, [registry, mergeSnapshot, notify]);

  /** Close a tab, prompting for dirty documents via close dialog. */
  const closeTab = useCallback(
    async (id: string) => {
      if (id.startsWith("image:")) {
        setImageTabs(prev => { const next = { ...prev }; delete next[id]; return next; });
        setTabs(prev => {
          const next = prev.filter(item => item !== id);
          if (activeRef.current === id) setActiveId(next[next.length - 1] ?? null);
          return next;
        });
        return;
      }
      if (!registry) {
        setTabs((prev) => {
          const next = prev.filter((item) => item !== id);
          if (activeRef.current === id) setActiveId(next[next.length - 1] ?? null);
          return next;
        });
        return;
      }
      const current = docsRef.current[id];
      if (current?.dirty) {
        setCloseDecision(id);
        return;
      }
      try {
        await workspaceGateway!.closeDocument({ ...(current?.location ? { location: current.location } : {}), documentId: id, baseRevision: current?.revision ?? 0 }, "discard");
      } catch (cause) {
        setNotice(localizedFailure(cause, workspaceErrorText), "error");
        return;
      }
      setTabs((prev) => {
        const next = prev.filter((item) => item !== id);
        if (activeRef.current === id) setActiveId(next[next.length - 1] ?? null);
        return next;
      });
      setDocs((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    },
    [registry, workspaceGateway, notify],
  );

  /** Move an unedited document's file to the trash and drop its tab; throws when refused. */
  const trashDocument = useCallback(async (id: string, revision: number) => {
    const current = docsRef.current[id];
    if (!workspaceGateway?.trashDocument) throw new Error("trash is unavailable");
    await workspaceGateway.trashDocument({ ...(current?.location ? { location: current.location } : {}), documentId: id, baseRevision: revision });
    setTabs((prev) => {
      const next = prev.filter((item) => item !== id);
      if (activeRef.current === id) setActiveId(next[next.length - 1] ?? null);
      return next;
    });
    setDocs((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, [workspaceGateway]);

  /** Resolve the dirty-close dialog with save, discard, or cancel. */
  const resolveCloseDecision = useCallback(
    async (action: "save" | "discard" | "cancel") => {
      const id = closeDecision;
      setCloseDecision(null);
      if (!id || action === "cancel") return;
      if (!registry) return;
      const current = docsRef.current[id];
      try {
        const closed = await workspaceGateway!.closeDocument({ ...(current?.location ? { location: current.location } : {}), documentId: id, baseRevision: current?.revision ?? 0 }, action);
        if (!closed) {
          setNotice(message("閉じる操作を取り消しました。本文は保持しています。"));
          return;
        }
      } catch (cause) {
        setNotice(localizedFailure(cause, workspaceErrorText), "error");
        return;
      }
      setTabs((prev) => {
        const next = prev.filter((item) => item !== id);
        if (activeRef.current === id) setActiveId(next[next.length - 1] ?? null);
        return next;
      });
      setDocs((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    },
    [closeDecision, registry, workspaceGateway, notify],
  );

  /** Open a file by path through the registry with cursor refresh. */
  const openFile = useCallback(
    async (path: string, scope?: RootScope) => {
      if (!registry) {
        // Browser demo: tabs over static samples.
        setTabs((prev) => (prev.includes(path) ? prev : [...prev, path]));
        setActiveId(path);
        return;
      }
      if (isImagePath(path)) {
        if (scope && !roots.current.some((root) => sameRoot(root.scope, scope))) return;
        const id = scope ? imageTabId(scope.rootId, path) : "image:" + path;
        setImageTabs(prev => ({ ...prev, [id]: path }));
        setTabs(prev => prev.includes(id) ? prev : [...prev, id]);
        setActiveId(id);
        return;
      }
      try {
        const open = await (isMarkdownPath(path) ? workspaceGateway!.openMarkdown(path, scope) : workspaceGateway!.openTextFile(path, scope));
        if (scope && !roots.current.some((root) => sameRoot(root.scope, scope))) return;
        const doc = docFromOpen(open);
        if (registry) registry.noteSnapshot(open.snapshot);
        setDocs((prev) => ({ ...prev, [doc.documentId]: doc }));
        setTabs((prev) => (prev.includes(doc.documentId) ? prev : [...prev, doc.documentId]));
        setActiveId(doc.documentId);
        setExternalByDoc((prev) => {
          if (!(doc.documentId in prev)) return prev;
          const next = { ...prev };
          delete next[doc.documentId];
          return next;
        });
        await refreshModeCursor(doc.documentId);
      } catch (cause) {
        setNotice(localizedFailure(cause, workspaceErrorText), "error");
      }
    },
    [registry, workspaceGateway, refreshModeCursor, notify],
  );

  useEffect(() => {
    if (!desktop || !activeId || !docsRef.current[activeId]) return;
    void refreshModeCursor(activeId);
  }, [desktop, activeId, refreshModeCursor]);

  return {
    registry,
    docs,
    setDocs,
    docsRef,
    tabs,
    setTabs,
    activeId,
    setActiveId,
    activeRef,
    active,
    activeImage,
    activeIsMarkdown,
    imageTabs,
    setImageTabs,
    selections,
    setSelections,
    cursorEcho,
    echoCursor,
    vimMode,
    commandLine,
    completion,
    quickfix,
    clearQuickfix,
    exReports,
    searchCount,
    vimMessage,
    setVimMode,
    vimModeRef,
    vimKeys,
    setVimKeys,
    caretRef,
    externalByDoc,
    setExternalByDoc,
    conflictDoc,
    setConflictDoc,
    closeDecision,
    setCloseDecision,
    copyReady,
    setCopyReady,
    bumpSelectionGen,
    isSelectionGenCurrent,
    currentSelectionGen,
    sayStale,
    mergeSnapshot,
    refreshModeCursor,
    refreshModeAfterSelection,
    handleSelection,
    jumpToOffset,
    applyNativeText,
    applyEdits,
    writeYankToClipboard,
    handleUndo,
    handleRedo,
    handleSave,
    handleReload,
    closeTab,
    trashDocument,
    resolveCloseDecision,
    openFile,
    configureRoots,
    imageScope,
    demo,
  };
}

/** Return type of the document session hook for sibling hook composition. */
export type DocumentSessionHandle = ReturnType<typeof useDocumentSession>;

