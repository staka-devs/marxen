import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Bot, Files, FolderOpen, ListTree, Save, Search, Settings as SettingsIcon, Ellipsis, PanelsLeftRight } from "lucide-react";
import { CodeMirrorEditor, type EditorSelection, type ExternalCursor } from "../editor/CodeMirrorEditor";
import { MarkdownPreview } from "../preview/MarkdownPreview";
import AiPanel from "../ai-panel";
import InlineChat from "../ai-inline-chat";
import ReviewPanel from "../review-panel";
import type { AiProviderConfig, ContextSummary, PromptMode, ProposalText, PromptContext } from "../../shared/ai-contracts";
import { buildProviderConfig } from "../../lib/ai";
import { loadAiProfile } from "../../lib/ai-profiles";
import { resolveInlineTarget } from "../../lib/ai-inline-target";
import { EditorView } from "@codemirror/view";
import type { ApproveDocOutcome, IsolationDiff } from "../../shared/isolation-contracts";
import {
  approveIsolatedCopy,
  cancelIsolatedCopy,
  createIsolatedCopy,
  fetchIsolationDiff,
  rejectIsolatedCopy,
  stageProposal,
  describeWorkspaceError as describeIsolationError,
} from "../../lib/isolation";
import { FileTree, buildTree } from "../workspace/FileTree";
import { ImageViewer } from "../workspace/ImageViewer";
import { ImageDropZone, type ImageDrop } from "../workspace/ImageDropZone";
import { entryKind, isImagePath, isMarkdownPath } from "../../lib/workspace-files";
import { Tabs, type TabItem } from "../workspace/Tabs";
import { QuickOpen } from "../workspace/QuickOpen";
import { SearchPanel, type SearchHitItem } from "../workspace/SearchPanel";
import { Outline } from "../workspace/Outline";
import { CommandPalette, type PaletteCommand } from "../workspace/CommandPalette";
import { SettingsPanel } from "../workspace/SettingsPanel";
import { RawGridView } from "../workspace/RawGridView";
import { GuiToolbar } from "../workspace/GuiToolbar";
import { readRuntimeStatus } from "../../lib/runtime";
import type {
  DocumentSnapshot,
  OpenDocument,
  RecoveryEntry,
  RuntimeStatus,
  SearchMatch,
  TextEdit,
  WorkspaceEntry,
  WorkspaceEvent,
} from "../../shared/contracts";
import {
  formatRange,
  insertImage,
  insertLink,
  insertTable,
  tableAddColumn,
  tableAddRow,
  toggleCheckbox,
  type FormatKind,
} from "../../lib/markdown-gui";
import {
  SAMPLE_WORKSPACE,
  isSupportedConfigName,
  listenWorkspaceEvents,
  replaceEdits,
  searchWorkspace as searchLocal,
  workspaceApi,
  type ThemeId,
} from "../../lib/workspace";
import { pickConfigFile, pickFolder } from "../../lib/native-dialog";
import {
  READONLY_MESSAGE,
  RegistryClient,
  StaleResync,
  createClient,
  isDesktop,
  serializeVimKey,
  workspaceErrorText,
} from "../../lib/document-client";
import { applyGridUpdates, createGridState, type NvimGridState } from "../../lib/grid";
import type { ImageResolver } from "../preview/images";
import { offsetToLineCol } from "../../lib/utf16";
import { correspondSource as correspondSnapshotSource, resolveEditRange } from "../../lib/selection-range";
import { copyYankToClipboard, COPY_LABELS } from "../../lib/clipboard";
import type { YankCopy } from "../../shared/contracts";
import { loadEditorPreferences, saveEditorPreferences, normalizeEditorPreferences, type EditorPreferences } from "../../lib/editor-preferences";

export type ViewMode = "live" | "source" | "read" | "split";
export type NavBasis = "display" | "source";
export type SideView = "explorer" | "search" | "outline";

interface OpenDoc {
  documentId: string;
  path: string | null;
  text: string;
  revision: number;
  dirty: boolean;
}

interface ExternalInfo {
  path: string;
  deleted: boolean;
}

const MODE_JA: Record<string, string> = {
  normal: "ノーマル",
  insert: "挿入",
  replace: "置換",
  visual: "選択",
  visual_line: "行選択",
  visual_block: "矩形選択",
  command_line: "コマンド",
  terminal: "ターミナル",
};

const MODE_LABEL: Record<ViewMode, string> = {
  live: "ライブプレビュー",
  source: "Markdown",
  read: "プレビュー",
  split: "分割表示",
};

function docFromOpen(open: OpenDocument): OpenDoc {
  return {
    documentId: open.snapshot.documentId,
    path: open.path,
    text: open.snapshot.text,
    revision: open.snapshot.revision,
    dirty: open.snapshot.dirty,
  };
}

function applySnapshot(doc: OpenDoc, snapshot: DocumentSnapshot): OpenDoc {
  return { ...doc, text: snapshot.text, revision: snapshot.revision, dirty: snapshot.dirty };
}

function fileLabel(path: string | null, fallback: string): string {
  if (!path) return fallback;
  const base = path.split("/").pop() ?? path;
  return base === "" ? path : base;
}

function matchToHit(match: SearchMatch): SearchHitItem {
  return {
    path: match.path,
    line: match.line,
    col: 0,
    preview: match.preview,
    documentId: match.documentId,
    revision: match.revision,
    offset: match.range.start,
    end: match.range.end,
  };
}

export function WorkspaceShell() {
  const [desktop] = useState(() => isDesktop());
  const client = useMemo(() => createClient(), []);
  const registry = client instanceof RegistryClient ? client : null;

  // Demo samples for the read-only browser (never authoritative).
  const demo = useMemo(() => {
    const docs: Record<string, OpenDoc> = {};
    for (const file of SAMPLE_WORKSPACE) {
      docs[file.path] = { documentId: file.path, path: file.path, text: file.text, revision: 0, dirty: false };
    }
    return docs;
  }, []);

  const [wsRoot, setWsRoot] = useState<string | null>(null);
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [docs, setDocs] = useState<Record<string, OpenDoc>>(desktop ? {} : demo);
  const [imageTabs, setImageTabs] = useState<Record<string, string>>({});
  const [tabs, setTabs] = useState<string[]>(() => (desktop ? [] : [SAMPLE_WORKSPACE[0].path]));
  const [activeId, setActiveId] = useState<string | null>(() => (desktop ? null : SAMPLE_WORKSPACE[0].path));
  const [viewMode, setViewMode] = useState<ViewMode>("live");
  const [splitRatio, setSplitRatio] = useState(50);
  const [navBasis, setNavBasis] = useState<NavBasis>("source");
  const [showRaw, setShowRaw] = useState(false);
  const [sideView, setSideView] = useState<SideView | null>("explorer");
  const [showAi, setShowAi] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [manualFolder, setManualFolder] = useState(false);
  const [aiDismissed, setAiDismissed] = useState(false);
  const [aiProposal, setAiProposal] = useState<{ proposal: ProposalText; sent: ContextSummary[]; mode: PromptMode } | null>(null);
  const [staging, setStaging] = useState<{ copyId: string } | null>(null);
  const [aiProvider, setAiProvider] = useState<AiProviderConfig>(() => buildProviderConfig(loadAiProfile()));
  const [aiSettingsToken, setAiSettingsToken] = useState(0);
  // Mutual fence for the single shared staging slot: while one chat runs,
  // the other chat's send stays disabled so its owned copy cannot be lost.
  const [agentBusy, setAgentBusy] = useState(false);
  const [inlineBusy, setInlineBusy] = useState(false);
  const chatOwnerRef = useRef<"agent" | "inline" | null>(null);
  const setAgentChatBusy = useCallback((busy: boolean) => {
    if (busy && chatOwnerRef.current === null) chatOwnerRef.current = "agent";
    if (!busy && chatOwnerRef.current === "agent") chatOwnerRef.current = null;
    setAgentBusy(busy);
  }, []);
  const setInlineChatBusy = useCallback((busy: boolean) => {
    if (busy && chatOwnerRef.current === null) chatOwnerRef.current = "inline";
    if (!busy && chatOwnerRef.current === "inline") chatOwnerRef.current = null;
    setInlineBusy(busy);
  }, []);
  const [inlineOpen, setInlineOpen] = useState(false);
  const [inlineSnapshot, setInlineSnapshot] = useState<PromptContext | null>(null);
  const [inlineKind, setInlineKind] = useState<"selection" | "paragraph">("selection");
  const [diffs, setDiffs] = useState<IsolationDiff[]>([]);
  const [outcomes, setOutcomes] = useState<ApproveDocOutcome[]>([]);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewMessage, setReviewMessage] = useState<string | null>(null);
  const [reviewStatus, setReviewStatus] = useState<string | null>(null);
  const [preferences, setPreferences] = useState(loadEditorPreferences);
  const theme = preferences.theme;
  const updatePreferences = useCallback((next: EditorPreferences) => {
    const normalized = normalizeEditorPreferences(next);
    setPreferences(normalized);
    if (!saveEditorPreferences(normalized)) setNotice("設定を保存できませんでした。この起動中は変更を保持します。");
  }, []);
  const setTheme = (next: ThemeId) => updatePreferences({ ...preferences, theme: next });
  const [quickOpen, setQuickOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [settings, setSettings] = useState(false);
  const [folderInput, setFolderInput] = useState("");
  const [selections, setSelections] = useState<Record<string, EditorSelection>>({});
  const [cursorEcho, setCursorEcho] = useState<Record<string, ExternalCursor>>({});
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [vimMode, setVimMode] = useState("normal");
  const [vimKeys, setVimKeys] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [configPath, setConfigPath] = useState("");
  const [configError, setConfigError] = useState<string | null>(null);
  const [applyingConfig, setApplyingConfig] = useState(false);
  const [currentConfig, setCurrentConfig] = useState<string | null>(null);
  const [copyKeys, setCopyKeys] = useState<Record<string, string>>({
    markdown: "<F6>", text: "<F7>", rich: "<F8>", html: "<F9>",
  });
  const [copyReady, setCopyReady] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [registryHits, setRegistryHits] = useState<SearchHitItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [replaceText, setReplaceText] = useState("");
  const [recovery, setRecovery] = useState<RecoveryEntry[]>([]);
  const [externalByDoc, setExternalByDoc] = useState<Record<string, ExternalInfo>>({});
  const [conflictDoc, setConflictDoc] = useState<string | null>(null);
  const [closeDecision, setCloseDecision] = useState<string | null>(null);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");
  const [renameDoc, setRenameDoc] = useState<string | null>(null);
  const [renamePath, setRenamePath] = useState("");
  const [nvimGrid, setNvimGrid] = useState<NvimGridState | null>(null);
  const [gridRev, setGridRev] = useState<number | null>(null);

  const docsRef = useRef(docs);
  docsRef.current = docs;
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  // Dedicated cursor sequence: every echo gets a fresh token so navigation
  // without text change is never suppressed by revision equality.
  const cursorSeq = useRef(0);
  const echoCursor = useCallback((id: string, anchor: number, head: number) => {
    cursorSeq.current += 1;
    const seq = cursorSeq.current;
    setCursorEcho((prev) => ({ ...prev, [id]: { anchor, head, seq } }));
  }, []);
  const navRef = useRef(navBasis);
  navRef.current = navBasis;
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
  const bumpSelectionGen = useCallback((id: string): number => {
    const next = (selectionGenRef.current[id] ?? 0) + 1;
    selectionGenRef.current[id] = next;
    return next;
  }, []);
  const isSelectionGenCurrent = useCallback((id: string, gen: number): boolean => {
    return (selectionGenRef.current[id] ?? 0) === gen;
  }, []);

  const active: OpenDoc | null = activeId ? (docs[activeId] ?? null) : null;
  const activeImage = activeId ? imageTabs[activeId] : undefined;
  const activeIsMarkdown = active !== null && isMarkdownPath(active.path);
  const effectiveViewMode: ViewMode = active && !activeIsMarkdown ? "source" : viewMode;

  const sayStale = useCallback((snapshot: DocumentSnapshot) => {
    const id = snapshot.documentId;
    setDocs((prev) => {
      const doc = prev[id];
      if (!doc || snapshot.revision < doc.revision) return prev;
      return { ...prev, [id]: applySnapshot(doc, snapshot) };
    });
    setNotice(new StaleResync(snapshot).message);
  }, []);

  const mergeSnapshot = useCallback(
    (snapshot: DocumentSnapshot) => {
      if (registry instanceof RegistryClient) registry.noteSnapshot(snapshot);
      setDocs((prev) => {
        const doc = prev[snapshot.documentId];
        if (!doc || snapshot.revision < doc.revision) return prev;
        return { ...prev, [snapshot.documentId]: applySnapshot(doc, snapshot) };
      });
    },
    [registry],
  );

  const refreshModeCursor = useCallback(
    async (id: string, gen?: number) => {
      if (!registry) return;
      // A generation captured at the user gesture (or, by default, now):
      // async completions whose generation went stale never overwrite a
      // newer selection, echo, or mode display.
      const ticket = gen ?? selectionGenRef.current[id] ?? 0;
      try {
        const mode = await registry.fetchMode(id);
        if (!isSelectionGenCurrent(id, ticket)) return;
        if (activeRef.current === id) setVimMode(mode.mode);
      } catch {
        // Best-effort display only.
      }
      try {
        const cursor = await registry.fetchCursor(id);
        if (!isSelectionGenCurrent(id, ticket)) return;
        setSelections((prev) => ({ ...prev, [id]: { anchor: cursor.anchor, head: cursor.head } }));
        caretRef.current[id] = cursor.head;
        echoCursor(id, cursor.anchor, cursor.head);
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
  const refreshModeAfterSelection = useCallback(
    async (id: string, reported: EditorSelection, gen: number) => {
      if (!registry) return;
      let mode: string;
      try {
        const update = await registry.fetchMode(id);
        if (!isSelectionGenCurrent(id, gen)) return;
        mode = update.mode;
        if (activeRef.current === id) setVimMode(mode);
      } catch {
        return;
      }
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

  // -- workspace lifecycle -------------------------------------------------

  const loadEntries = useCallback(async (): Promise<WorkspaceEntry[]> => {
    const root = await workspaceApi.listWorkspace("");
    const all = [...root];
    const queue = root.filter((entry) => entry.directory).map((entry) => entry.path);
    const seen = new Set<string>(queue);
    while (queue.length > 0) {
      const dir = queue.shift()!;
      try {
        const children = await workspaceApi.listWorkspace(dir);
        all.push(...children);
        for (const child of children) {
          if (child.directory && !seen.has(child.path)) {
            seen.add(child.path);
            queue.push(child.path);
          }
        }
      } catch {
        // Unreadable directories stay collapsed with their parent visible.
      }
      if (all.length > 2000) break;
    }
    setEntries(all);
    return all;
  }, []);

  const refreshRecovery = useCallback(async () => {
    if (!registry) return;
    try {
      setRecovery(await workspaceApi.listRecovery());
    } catch (cause) {
      setNotice(workspaceErrorText(cause));
    }
  }, [registry]);

  const openWorkspaceFolder = useCallback(
    async (path: string) => {
      if (!registry) {
        setNotice(READONLY_MESSAGE);
        return;
      }
      const trimmed = path.trim();
      if (trimmed === "") {
        setNotice("フォルダーの絶対パスを入力してください。");
        return;
      }
      try {
        const info = await workspaceApi.openWorkspace(trimmed);
        setWsRoot(info.root);
        setManualFolder(false);
        await loadEntries();
        const open = await workspaceApi.listDocuments();
        const next: Record<string, OpenDoc> = {};
        for (const doc of open) {
          if (registry instanceof RegistryClient) registry.noteSnapshot(doc.snapshot);
          next[doc.snapshot.documentId] = docFromOpen(doc);
        }
        setDocs(next);
        setImageTabs({});
        const ids = open.map((doc) => doc.snapshot.documentId);
        setTabs(ids);
        setActiveId(ids[0] ?? null);
        setExternalByDoc({});
        setConflictDoc(null);
        await refreshRecovery();
        setNotice(null);
      } catch (cause) {
        setNotice(workspaceErrorText(cause));
      }
    },
    [registry, loadEntries, refreshRecovery],
  );

  const pickFolderAndOpen = useCallback(async () => {
    if (!registry) {
      setNotice(READONLY_MESSAGE);
      return;
    }
    const picked = await pickFolder();
    if (picked) await openWorkspaceFolder(picked);
  }, [registry, openWorkspaceFolder]);

  const openFile = useCallback(
    async (path: string) => {
      if (!registry) {
        // Browser demo: tabs over static samples.
        setTabs((prev) => (prev.includes(path) ? prev : [...prev, path]));
        setActiveId(path);
        return;
      }
      if (isImagePath(path)) {
        const id = "image:" + path;
        setImageTabs(prev => ({ ...prev, [id]: path }));
        setTabs(prev => prev.includes(id) ? prev : [...prev, id]);
        setActiveId(id);
        return;
      }
      try {
        const open = await (isMarkdownPath(path) ? workspaceApi.openMarkdown(path) : workspaceApi.openTextFile(path));
        const doc = docFromOpen(open);
        if (registry instanceof RegistryClient) registry.noteSnapshot(open.snapshot);
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
        setNotice(workspaceErrorText(cause));
      }
    },
    [registry, refreshModeCursor],
  );

  // -- mutations (desktop serial registry; browser read-only) --------------

  const applyEdits = useCallback(
    async (id: string, edits: TextEdit[]) => {
      if (!registry) {
        setNotice(READONLY_MESSAGE);
        return;
      }
      const current = docsRef.current[id];
      if (!current || edits.length === 0) return;
      bumpSelectionGen(id);
      try {
        const snapshot = await registry.applyEdits({ documentId: id, baseRevision: current.revision }, edits);
        mergeSnapshot(snapshot);
      } catch (cause) {
        if (cause instanceof StaleResync) sayStale(cause.snapshot);
        else setNotice(workspaceErrorText(cause));
      }
    },
    [registry, mergeSnapshot, sayStale, bumpSelectionGen],
  );

  const writeYankToClipboard = useCallback(async (copy: YankCopy, id: string) => {
    try {
      await copyYankToClipboard(copy, id);
      setNotice(`${COPY_LABELS[copy.format]}をコピーしました。`);
    } finally {
      setCopyReady((ready) => ready === id ? null : ready);
    }
  }, []);

  const routeVimKeys = useCallback(
    async (id: string, keys: string) => {
      if (!registry) {
        setNotice(READONLY_MESSAGE);
        return;
      }
      if (!docsRef.current[id]) return;
      setVimKeys((prev) => (prev + keys).slice(-24));
      const gen = bumpSelectionGen(id);
      try {
        // Revision binds at queue execution inside the client, so bursts
        // order against successive acknowledgements.
        const result = await registry.vimInputWithCopy(id, keys, (copy) => writeYankToClipboard(copy, id));
        mergeSnapshot(result.snapshot);
        if (activeRef.current === id && isSelectionGenCurrent(id, gen)) setCopyReady(result.copyReady ? id : null);
        await refreshModeCursor(id, gen);
      } catch (cause) {
        if (cause instanceof StaleResync) sayStale(cause.snapshot);
        else setNotice(workspaceErrorText(cause));
      }
    },
    [registry, mergeSnapshot, refreshModeCursor, sayStale, bumpSelectionGen, isSelectionGenCurrent, writeYankToClipboard],
  );

  const handleUndo = useCallback(async () => {
    if (!registry || !activeRef.current) {
      setNotice(READONLY_MESSAGE);
      return;
    }
    const id = activeRef.current;
    const gen = bumpSelectionGen(id);
    try {
      mergeSnapshot(await registry.undo(id));
      await refreshModeCursor(id, gen);
    } catch (cause) {
      setNotice(workspaceErrorText(cause));
    }
  }, [registry, mergeSnapshot, refreshModeCursor, bumpSelectionGen]);

  const handleRedo = useCallback(async () => {
    if (!registry || !activeRef.current) {
      setNotice(READONLY_MESSAGE);
      return;
    }
    const id = activeRef.current;
    const gen = bumpSelectionGen(id);
    try {
      mergeSnapshot(await registry.redo(id));
      await refreshModeCursor(id, gen);
    } catch (cause) {
      setNotice(workspaceErrorText(cause));
    }
  }, [registry, mergeSnapshot, refreshModeCursor, bumpSelectionGen]);

  const handleSave = useCallback(async () => {
    if (!registry || !activeRef.current) {
      setNotice(READONLY_MESSAGE);
      return;
    }
    const id = activeRef.current;
    const current = docsRef.current[id];
    if (!current) return;
    try {
      const result = await registry.save({ documentId: id, baseRevision: current.revision });
      setDocs((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], revision: result.revision, dirty: result.dirty } } : prev));
      setConflictDoc((prev) => (prev === id ? null : prev));
      setNotice("保存しました。");
    } catch (cause) {
      if (cause instanceof StaleResync) {
        sayStale(cause.snapshot);
        return;
      }
      const record = cause as { code?: unknown };
      if (typeof record === "object" && record !== null && record.code === "conflict") {
        setConflictDoc(id);
      }
      setNotice(workspaceErrorText(cause));
    }
  }, [registry, sayStale]);

  const handleReload = useCallback(async () => {
    if (!registry || !activeRef.current) {
      setNotice(READONLY_MESSAGE);
      return;
    }
    const id = activeRef.current;
    const current = docsRef.current[id];
    if (!current) return;
    try {
      mergeSnapshot(await registry.reload({ documentId: id, baseRevision: current.revision }));
      setExternalByDoc((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setNotice("最新のMarkdownに再読込しました。");
    } catch (cause) {
      setNotice(workspaceErrorText(cause));
    }
  }, [registry, mergeSnapshot]);

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
        await workspaceApi.closeDocument({ documentId: id, baseRevision: current?.revision ?? 0 }, "discard");
      } catch (cause) {
        setNotice(workspaceErrorText(cause));
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
    [registry],
  );

  const resolveCloseDecision = useCallback(
    async (action: "save" | "discard" | "cancel") => {
      const id = closeDecision;
      setCloseDecision(null);
      if (!id || action === "cancel") return;
      if (!registry) return;
      const current = docsRef.current[id];
      try {
        const closed = await workspaceApi.closeDocument({ documentId: id, baseRevision: current?.revision ?? 0 }, action);
        if (!closed) {
          setNotice("閉じる操作を取り消しました。本文は保持しています。");
          return;
        }
      } catch (cause) {
        setNotice(workspaceErrorText(cause));
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
    [closeDecision, registry],
  );

  // -- selection / cursor ---------------------------------------------------

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
        .stageCursor(id, selection.anchor, selection.head)
        .then(() => {
          void refreshModeAfterSelection(id, selection, gen);
        })
        .catch(() => undefined);
    },
    [registry, bumpSelectionGen, refreshModeAfterSelection],
  );

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

  // -- GUI range actions -----------------------------------------------------

  const guiAtSelection = useCallback(
    (fn: (text: string, anchor: number, head: number) => TextEdit[]) => {
      const id = activeRef.current;
      if (!id) return;
      if (!registry) {
        setNotice(READONLY_MESSAGE);
        return;
      }
      const current = docsRef.current[id];
      if (!current) return;
      const sel = selections[id] ?? { anchor: 0, head: 0 };
      const anchor = Math.min(sel.anchor, current.text.length);
      const head = Math.min(sel.head, current.text.length);
      void applyEdits(id, fn(current.text, Math.min(anchor, head), Math.max(anchor, head)));
    },
    [applyEdits, registry, selections],
  );

  // -- Vim key router (shell level; CodeMirror internals untouched) ---------
  //
  // Event-time work stays synchronous (no awaiting before enqueue) so
  // multi-key g/gg and operator prefixes never block: each keystroke is
  // queued immediately and the actual native mode is read inside the serial
  // queue, where routing and mapping checks happen at execution. Printable
  // keys therefore never consult stale Normal/Insert refs for routing.
  // Optimistic caret: GUI edits always collapse, so bursts advance a single
  // collapsed caret; a fresh noncollapsed selection is consumed once by the
  // first key and then collapses. Corrected by cursor echoes and refreshes.
  const caretRef = useRef<Record<string, number>>({});
  // Insert-mode keyboard Ctrl+V is recorded here WITHOUT preventing default:
  // the follow-up paste event carries the bytes synchronously (OS image
  // pastes emit no readable text via readText, and readText can fail in a
  // native WebView while normal paste works). The capture handler below
  // prevents default synchronously and routes exactly once.
  const pendingPasteRef = useRef<{ time: number; dropText: boolean } | null>(null);

  /** Exact half-open range for one edit plus the full source it was read from. */
  const takeRange = useCallback(
    (id: string): { range: { start: number; end: number }; fullText: string } => {
      const text = docsRef.current[id]?.text ?? "";
      const sel = selections[id] ?? { anchor: 0, head: 0 };
      const range = resolveEditRange(text.length, sel.anchor, sel.head, caretRef.current[id]);
      return { range, fullText: text };
    },
    [selections],
  );

  /**
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

  const routeCharKey = useCallback(
    async (id: string, key: string, range: { start: number; end: number }, fullText: string, retried = false): Promise<void> => {
      if (!registry) {
        setNotice(READONLY_MESSAGE);
        return;
      }
      if (!docsRef.current[id]) return;
      setVimKeys((prev) => (prev + key).slice(-24));
      const gen = retried ? selectionGenRef.current[id] ?? 0 : bumpSelectionGen(id);
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
          setNotice(workspaceErrorText(cause));
        }
      }
    },
    [registry, mergeSnapshot, refreshModeCursor, sayStale, echoCursor, correspondRange, bumpSelectionGen, isSelectionGenCurrent, writeYankToClipboard],
  );

  // Captured paste replaces the exact half-open range as one serial edit and
  // collapses there. Context-menu pastes (no keyboard gesture) never simulate
  // a mapping and insert directly.
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
        setNotice(READONLY_MESSAGE);
        return;
      }
      if (!docsRef.current[id]) return;
      if (text === "") return;
      const gen = retried ? selectionGenRef.current[id] ?? 0 : bumpSelectionGen(id);
      try {
        const decision = await registry.routeCapturedPaste(id, keyNotation, text, range);
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
          setNotice(workspaceErrorText(cause));
        }
      }
    },
    [registry, mergeSnapshot, refreshModeCursor, sayStale, echoCursor, correspondRange, bumpSelectionGen, isSelectionGenCurrent],
  );

  const onEditorKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!desktop || !registry || !activeRef.current) return;
      if (event.defaultPrevented || event.isPropagationStopped()) return;
      const native = event.nativeEvent;
      // IME preedit (including keyCode 229) is never a Vim motion and never a
      // GUI change here; composition commits flow through the editor once.
      if (native.isComposing || event.key === "Process" || native.keyCode === 229) return;
      const target = event.target as HTMLElement | null;
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
        // Enqueue immediately so pending g/gg and operator prefixes never
        // block. When the event-time mode is insert/replace, take the exact
        // range with an optimistic caret and let the queue read the actual
        // mode; otherwise fall back to real native input with no speculative
        // range, so fast Normal->i->characters cannot use invented offsets.
        event.preventDefault();
        event.stopPropagation();
        if (!docsRef.current[id]) return;
        const insertHint = vimModeRef.current === "insert" || vimModeRef.current === "replace";
        if (!insertHint) {
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

  // -- paste text/images (capture phase; preview pipeline untouched) --------
  //
  // Event-first clipboard: the paste event's clipboardData is read
  // synchronously (text AND image bytes) and default is prevented
  // synchronously, before CodeMirror can insert anything. No async
  // preventDefault after insertion, no readText round-trip, exactly once.
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
          else setNotice(workspaceErrorText(cause));
        }
      }
    },
    [registry, mergeSnapshot, sayStale, echoCursor, isSelectionGenCurrent, bumpSelectionGen],
  );

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
    [desktop, registry, takeRange, pasteImageFiles, routeCapturedPaste],
  );

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
        else setNotice(workspaceErrorText(cause));
      }
    })();
  }, [registry, pasteImageFiles, bumpSelectionGen, mergeSnapshot, isSelectionGenCurrent, echoCursor, loadEntries, sayStale]);

  const dropSelection = active ? {
    start: Math.min(selections[active.documentId]?.anchor ?? 0, selections[active.documentId]?.head ?? 0),
    end: Math.max(selections[active.documentId]?.anchor ?? 0, selections[active.documentId]?.head ?? 0),
  } : { start: 0, end: 0 };

  // -- search + revision-aware replace ---------------------------------------

  useEffect(() => {
    if (!desktop || !wsRoot) return;
    if (searchQuery === "") {
      setRegistryHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      workspaceApi
        .searchWorkspace(searchQuery)
        .then((matches) => setRegistryHits(matches.map(matchToHit)))
        .catch((cause: unknown) => setNotice(workspaceErrorText(cause)))
        .finally(() => setSearching(false));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [desktop, wsRoot, searchQuery]);

  const localHits: SearchHitItem[] = useMemo(() => {
    if (desktop) return [];
    if (searchQuery === "") return [];
    const files = Object.values(docs).map((doc) => ({ path: doc.path ?? doc.documentId, text: doc.text }));
    const hits: SearchHitItem[] = [];
    for (const file of files) {
      for (const local of searchLocal([{ path: file.path, text: file.text }], searchQuery, 50)) {
        hits.push({ ...local, offset: 0, end: 0 });
      }
    }
    return hits.slice(0, 50);
  }, [desktop, docs, searchQuery]);

  const jumpToHit = useCallback(
    async (hit: SearchHitItem) => {
      if (!desktop || !registry) {
        if (hit.path) {
          setTabs((prev) => (prev.includes(hit.path) ? prev : [...prev, hit.path]));
          setActiveId(hit.path);
        }
        return;
      }
      let id = hit.documentId ?? null;
      if (!id) {
        try {
          const open = await workspaceApi.openMarkdown(hit.path);
          const doc = docFromOpen(open);
          if (registry instanceof RegistryClient) registry.noteSnapshot(open.snapshot);
          setDocs((prev) => ({ ...prev, [doc.documentId]: doc }));
          setTabs((prev) => (prev.includes(doc.documentId) ? prev : [...prev, doc.documentId]));
          id = doc.documentId;
        } catch (cause) {
          setNotice(workspaceErrorText(cause));
          return;
        }
      } else {
        setTabs((prev) => (prev.includes(id!) ? prev : [...prev, id!]));
      }
      setActiveId(id);
      const start = hit.offset ?? 0;
      await jumpToOffset(id, start, hit.end ?? start);
    },
    [desktop, registry, jumpToOffset],
  );

  const replaceOne = useCallback(
    async (hit: SearchHitItem) => {
      if (!registry) {
        setNotice(READONLY_MESSAGE);
        return;
      }
      if (searchQuery === "") return;
      let id = hit.documentId ?? null;
      try {
        if (!id) {
          const open = await workspaceApi.openMarkdown(hit.path);
          const doc = docFromOpen(open);
          if (registry instanceof RegistryClient) registry.noteSnapshot(open.snapshot);
          setDocs((prev) => ({ ...prev, [doc.documentId]: doc }));
          setTabs((prev) => (prev.includes(doc.documentId) ? prev : [...prev, doc.documentId]));
          id = doc.documentId;
        }
        const snapshot = await workspaceApi.fetchSnapshot(id);
        mergeSnapshot(snapshot);
        const { edits, count } = replaceEdits(snapshot.text, searchQuery, replaceText);
        const single = edits.find((edit) => edit.range.start <= (hit.offset ?? 0) && (hit.offset ?? 0) < edit.range.end + searchQuery.length);
        const chosen = single ? [single] : [];
        if (chosen.length === 0 || count === 0) {
          setNotice("置換対象が見つかりませんでした。検索し直してください。");
          return;
        }
        const next = await registry.applyEdits({ documentId: id, baseRevision: snapshot.revision }, chosen);
        mergeSnapshot(next);
        const refreshed = await workspaceApi.searchWorkspace(searchQuery);
        setRegistryHits(refreshed.map(matchToHit));
      } catch (cause) {
        if (cause instanceof StaleResync) sayStale(cause.snapshot);
        else setNotice(workspaceErrorText(cause));
      }
    },
    [registry, searchQuery, replaceText, mergeSnapshot, sayStale],
  );

  const replaceAllMatches = useCallback(async () => {
    if (!registry) {
      setNotice(READONLY_MESSAGE);
      return;
    }
    if (searchQuery === "") return;
    const byPath = new Map<string, SearchHitItem[]>();
    for (const hit of registryHits) {
      const list = byPath.get(hit.path) ?? [];
      list.push(hit);
      byPath.set(hit.path, list);
    }
    let total = 0;
    for (const [path] of byPath) {
      try {
        const open = await workspaceApi.openMarkdown(path);
        const doc = docFromOpen(open);
        setDocs((prev) => ({ ...prev, [doc.documentId]: doc }));
        setTabs((prev) => (prev.includes(doc.documentId) ? prev : [...prev, doc.documentId]));
        const { edits, count } = replaceEdits(doc.text, searchQuery, replaceText);
        if (count === 0) continue;
        const next = await registry.applyEdits({ documentId: doc.documentId, baseRevision: doc.revision }, edits);
        mergeSnapshot(next);
        total += count;
      } catch (cause) {
        if (cause instanceof StaleResync) sayStale(cause.snapshot);
        else setNotice(workspaceErrorText(cause));
        return;
      }
    }
    setNotice(`${total} 件を置換しました。`);
    try {
      setRegistryHits((await workspaceApi.searchWorkspace(searchQuery)).map(matchToHit));
    } catch {
      // Count notice already shown; refresh is best-effort.
    }
  }, [registry, registryHits, searchQuery, replaceText, mergeSnapshot, sayStale]);

  // -- events / recovery -----------------------------------------------------

  // Native status must follow documents, not mount time: an empty workspace
  // reads disconnected while an open document reads connected, and a process
  // crash flips back through the event path below.
  const refreshRuntime = useCallback(() => {
    readRuntimeStatus()
      .then(setRuntime)
      .catch(() => setRuntime({ contractVersion: 1, connection: "error", detail: "接続状態を取得できません。" }));
  }, []);

  const handleEvents = useCallback(
    (events: WorkspaceEvent[]) => {
      if (events.length > 0) refreshRuntime();
      for (const event of events) {
        if (event.type === "external_change") {
          const { documentId, path, deleted } = event.payload;
          setExternalByDoc((prev) => ({ ...prev, [documentId]: { path, deleted } }));
        } else if (event.type === "snapshot") {
          mergeSnapshot(event.payload);
        } else if (event.type === "saved") {
          const result = event.payload;
          setDocs((prev) => {
            const doc = prev[result.documentId];
            if (!doc || result.revision < doc.revision) return prev;
            return { ...prev, [result.documentId]: { ...doc, revision: result.revision, dirty: result.dirty } };
          });
        } else if (event.type === "error") {
          setNotice(`文書エラー: ${workspaceErrorText(event.payload.error)}`);
        }
      }
    },
    [mergeSnapshot, refreshRuntime],
  );

  useEffect(() => {
    if (!desktop || !wsRoot) return;
    let stop: (() => void) | undefined;
    listenWorkspaceEvents(handleEvents).then((unlisten) => {
      stop = unlisten;
    });
    const timer = window.setInterval(() => {
      workspaceApi.pollEvents().then(handleEvents).catch(() => undefined);
    }, 4000);
    return () => {
      window.clearInterval(timer);
      stop?.();
    };
  }, [desktop, wsRoot, handleEvents]);

  useEffect(() => {
    let active = true;
    readRuntimeStatus()
      .then((status) => {
        if (active) setRuntime(status);
      })
      .catch(() => {
        if (active) setRuntime({ contractVersion: 1, connection: "error", detail: "接続状態を取得できません。" });
      });
    return () => {
      active = false;
    };
  }, []);

  // Native status refreshes with documents and workspace root; the mount
  // read above only seeds the first paint.
  useEffect(() => {
    if (desktop) refreshRuntime();
  }, [desktop, activeId, active?.revision, wsRoot, refreshRuntime]);

  useEffect(() => {
    if (!desktop || !activeId || !docsRef.current[activeId]) return;
    void refreshModeCursor(activeId);
  }, [desktop, activeId, refreshModeCursor]);

  // Native grid screen retains redraws/highlights without touching text.
  // Each fetch batch applies incrementally; switching docs or closing the
  // view resets so rows from another buffer never linger.
  useEffect(() => {
    if (!desktop || !activeId || !showRaw) {
      setNvimGrid(null);
      setGridRev(null);
      return;
    }
    let cancelled = false;
    setNvimGrid(createGridState());
    workspaceApi
      .fetchGrid(activeId, 80, 24)
      .then((grid) => {
        if (cancelled) return;
        setNvimGrid((prev) => applyGridUpdates(prev ?? createGridState(), grid.updates));
        setGridRev(grid.revision);
      })
      .catch((cause: unknown) => setNotice(workspaceErrorText(cause)));
    return () => {
      cancelled = true;
    };
  }, [desktop, activeId, showRaw, active?.revision]);

  const handleRawGridKeys = useCallback(
    (keys: string) => {
      const id = activeRef.current;
      if (id) void routeVimKeys(id, keys);
    },
    [routeVimKeys],
  );

  const handleRawGridRefresh = useCallback(() => {
    const id = activeRef.current;
    if (!id || !desktop) return;
    setNvimGrid(createGridState());
    workspaceApi
      .fetchGrid(id, 80, 24)
      .then((grid) => {
        setNvimGrid((prev) => applyGridUpdates(prev ?? createGridState(), grid.updates));
        setGridRev(grid.revision);
      })
      .catch((cause: unknown) => setNotice(workspaceErrorText(cause)));
  }, [desktop]);

  // Shared local-image hydration (ADR-0063): relative sources resolve through
  // the Rust workspace loader (containment/symlink/type checked) to data URLs.
  // Abort-aware and stale-safe; failures keep alt text, never fake content.
  // No secrets touch localStorage; credentials stay in the OS store.
  // The resolver is bound to an explicit document ID: late responses after
  // switching documents are rejected, and the read preview is keyed by
  // document so identical Markdown with the same filename cannot reuse
  // another document's bytes from an already-hydrated node.
  const imageUrlCache = useRef(new Map<string, string>());
  const makeImageResolver = useCallback(
    (documentId: string): ImageResolver =>
      async (src: string, signal: AbortSignal): Promise<string | null> => {
        if (!desktop) return null;
        if (signal.aborted) return null;
        const key = `${documentId}:${src}`;
        const cached = imageUrlCache.current.get(key);
        if (cached) {
          if (signal.aborted) return null;
          return cached;
        }
        try {
          const data = await workspaceApi.loadImage(documentId, src);
          if (signal.aborted) return null;
          // The user may have switched documents while the bytes were in
          // flight: only the resolver's own document may consume them.
          if (activeRef.current !== documentId) return null;
          if (!/^image\/(png|jpeg|gif|webp)$/.test(data.mime)) return null;
          let binary = "";
          const bytes = data.bytes;
          for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
          }
          const url = `data:${data.mime};base64,${btoa(binary)}`;
          imageUrlCache.current.set(key, url);
          return url;
        } catch {
          return null;
        }
      },
    [desktop],
  );
  const liveResolver = useMemo(
    () => (desktop && active ? makeImageResolver(active.documentId) : undefined),
    [desktop, active, makeImageResolver],
  );
  const readResolver = useMemo(
    () => (desktop && active ? makeImageResolver(active.documentId) : undefined),
    [desktop, active, makeImageResolver],
  );

  // -- config -----------------------------------------------------------------

  const applyConfig = useCallback(async () => {
    if (!registry || !activeRef.current) {
      setNotice(READONLY_MESSAGE);
      return;
    }
    const trimmed = configPath.trim();
    if (trimmed !== "" && !isSupportedConfigName(trimmed)) {
      setConfigError("対応する名前は vimrc / _vimrc / .vimrc / init.vim / init.lua です。");
      return;
    }
    const id = activeRef.current;
    const current = docsRef.current[id];
    if (!current) return;
    setApplyingConfig(true);
    try {
      const result = await registry.configure({ documentId: id, baseRevision: current.revision }, trimmed === "" ? null : trimmed);
      setConfigError(result.errors.length > 0 ? result.errors.join("\n") : null);
      setCurrentConfig(result.path);
      setCopyKeys(result.copyKeys ?? { markdown: "<F6>", text: "<F7>", rich: "<F8>", html: "<F9>" });
      const snapshot = await registry.fetchSnapshot(id);
      mergeSnapshot(snapshot);
      await refreshModeCursor(id);
      setNotice("設定を適用して再起動しました（Undo・モードは初期化）。");
    } catch (cause) {
      if (cause instanceof StaleResync) sayStale(cause.snapshot);
      else setNotice(workspaceErrorText(cause));
    } finally {
      setApplyingConfig(false);
    }
  }, [registry, configPath, mergeSnapshot, refreshModeCursor, sayStale]);

  useEffect(() => {
    if (!registry || !activeId || !docsRef.current[activeId]) return;
    registry
      .fetchConfig(activeId)
      .then((config) => {
        setCurrentConfig(config.path);
        setConfigError(config.errors.length > 0 ? config.errors.join("\n") : null);
        setCopyKeys(config.copyKeys ?? { markdown: "<F6>", text: "<F7>", rich: "<F8>", html: "<F9>" });
      })
      .catch(() => undefined);
  }, [settings, registry, activeId]);

  // -- palette / keys ----------------------------------------------------------

  // Late-bound opener for the inline chat (defined below with the AI scope).
  const openInlineChatRef = useRef<() => void>(() => undefined);

  const commands: PaletteCommand[] = useMemo(
    () => [
      { id: "view-live", label: "表示: ライブにする" },
      { id: "view-source", label: "表示: Markdownにする" },
      { id: "view-read", label: "表示: 閲覧にする" },
      { id: "view-split", label: "表示: 分割にする" },
      { id: "nav-display", label: "移動: 表示基準にする" },
      { id: "nav-source", label: "移動: Vim の移動にする" },
      { id: "file-new", label: "ファイル: 新規作成する" },
      { id: "file-rename", label: "ファイル: 名前を変更する" },
      { id: "file-save", label: "ファイル: 保存する" },
      { id: "file-reload", label: "ファイル: 再読込する" },
      { id: "file-close", label: "ファイル: 閉じる" },
      { id: "edit-undo", label: "編集: 元に戻す" },
      { id: "edit-redo", label: "編集: やり直す" },
      { id: "palette-quickopen", label: "移動: ファイルをすばやく開く" },
      { id: "palette-raw", label: "表示: Neovim 画面を切り替える" },
      { id: "palette-raw-refresh", label: "表示: Neovim 画面を更新する" },
      { id: "palette-recovery", label: "復旧: 復旧一覧を更新する" },
      { id: "palette-ai", label: "AI: AI 支援を開く" },
      { id: "inline-chat", label: "インライン: チャットを開く" },
      { id: "palette-settings", label: "設定: 設定を開く" },
    ],
    [],
  );

  const runCommand = useCallback(
    (id: string) => {      if (id === "view-live") setViewMode("live");
      else if (id === "view-source") setViewMode("source");
      else if (id === "view-read") setViewMode("read");
      else if (id === "view-split") setViewMode("split");
      else if (id === "nav-display") setNavBasis("display");
      else if (id === "nav-source") setNavBasis("source");
      else if (id === "file-save") void handleSave();
      else if (id === "file-reload") void handleReload();
      else if (id === "file-close" && activeRef.current) void closeTab(activeRef.current);
      else if (id === "file-new") {
        setNewFilePath("");
        setNewFileOpen(true);
      } else if (id === "file-rename" && activeRef.current) {
        const current = docsRef.current[activeRef.current];
        setRenamePath(current?.path ?? "");
        setRenameDoc(activeRef.current);
      } else if (id === "edit-undo") void handleUndo();
      else if (id === "edit-redo") void handleRedo();
      else if (id === "palette-quickopen") setQuickOpen(true);
      else if (id === "palette-raw") setShowRaw((value) => !value);
      else if (id === "palette-raw-refresh") handleRawGridRefresh();
      else if (id === "palette-recovery") void refreshRecovery();
      else if (id === "palette-ai") {
        if (!desktop) setNotice(READONLY_MESSAGE);
        else setShowAi(true);
      } else if (id === "inline-chat") {
        if (!desktop) setNotice(READONLY_MESSAGE);
        else openInlineChatRef.current();
      } else if (id === "palette-settings") setSettings(true);
    },
    [desktop, handleSave, handleReload, handleUndo, handleRedo, closeTab, refreshRecovery],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === "p" && !event.shiftKey) {
        event.preventDefault();
        setQuickOpen((value) => !value);
      } else if (mod && event.key.toLowerCase() === "p" && event.shiftKey) {
        event.preventDefault();
        setPalette((value) => !value);
      } else if (mod && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleSave]);

  // -- derived view data --------------------------------------------------------

  const treeNodes = useMemo(() => {
    if (desktop) {
      return buildTree(entries);
    }
    return buildTree(
      Object.keys(docs).map((path) => ({ path, name: path.split("/").pop() ?? path, directory: false, markdown: true })),
    );
  }, [desktop, entries, docs]);

  const tabItems: TabItem[] = useMemo(
    () =>
      tabs.map((id) => {
        const doc = docs[id];
        return { id, label: fileLabel(imageTabs[id] ?? doc?.path ?? null, id), dirty: doc?.dirty ?? false };
      }),
    [tabs, docs, imageTabs],
  );

  const quickPaths = useMemo(() => {
    const fromEntries = entries.filter((entry) => !entry.directory && entryKind(entry)).map((entry) => entry.path);
    const fromDocs = Object.values(docs).map((doc) => doc.path).filter((path): path is string => path !== null);
    return Array.from(new Set([...fromDocs, ...fromEntries, ...Object.keys(demo)]));
  }, [entries, docs, demo]);

  const cursorPos = useMemo(() => {
    if (!active) return null;
    const sel = selections[active.documentId] ?? { anchor: 0, head: 0 };
    try {
      const pos = offsetToLineCol(active.text, Math.min(sel.head, active.text.length));
      return `${pos.line + 1}:${pos.col + 1}`;
    } catch {
      return null;
    }
  }, [active, selections]);

  // Visible filename labels for AI scopes (never internal ids in product text).
  const contextLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const doc of Object.values(docs)) {
      const base = doc.path?.split("/").pop() ?? doc.documentId;
      labels[doc.documentId] = base === "" ? doc.documentId : base;
    }
    return labels;
  }, [docs]);

  const activeExternal = active ? externalByDoc[active.documentId] : undefined;
  const isConflicted = active ? conflictDoc === active.documentId : false;

  // Exact AI scope: the active document at its live revision with the GUI
  // selection as the single range. Dismissed per document; questions never
  // edit, and proposals only flow out through onProposal for #8 review.
  const aiContexts: PromptContext[] = useMemo(() => {
    if (!desktop || !active || aiDismissed) return [];
    const sel = selections[active.documentId] ?? { anchor: 0, head: 0 };
    const collapsed = sel.anchor === sel.head;
    const start = collapsed ? 0 : Math.min(sel.anchor, sel.head, active.text.length);
    const end = collapsed ? active.text.length : Math.min(Math.max(sel.anchor, sel.head), active.text.length);
    return [{ documentId: active.documentId, revision: active.revision, ranges: [{ start, end }], text: active.text.slice(start, end) }];
  }, [desktop, active, selections, aiDismissed]);

  const stagingRef = useRef<string | null>(null);
  stagingRef.current = staging?.copyId ?? null;
  const aiContextsRef = useRef<PromptContext[]>([]);
  aiContextsRef.current = aiContexts;

  const handleProposal = useCallback(
    async (proposal: ProposalText, sent: ContextSummary[], mode: PromptMode) => {
      setAiProposal({ proposal, sent, mode });
      const copyId = stagingRef.current;
      if (!copyId) {
        setNotice("AI の提案を受け取りました。差分を確認してください。");
        return;
      }
      if (mode === "ask") {
        // Questions display only; staging refuses ask.
        setNotice("AI の回答を受け取りました。");
        setReviewStatus("質問モードは表示のみです。取り込みは行いません。");
        setReviewBusy(true);
        try {
          const fetched = await fetchIsolationDiff(copyId);
          setDiffs(fetched);
          setReviewMessage(null);
        } catch (cause: unknown) {
          setReviewMessage(describeIsolationError(cause));
        } finally {
          setReviewBusy(false);
        }
        return;
      }
      setNotice("AI の変更案を受け取りました。差分を確認してください。");
      setReviewBusy(true);
      try {
        const staged = await stageProposal(copyId, proposal, mode);
        setReviewMessage(null);
        setReviewStatus(
          staged.updated.length > 0
            ? `${staged.updated.length} 文書に取り込みました（${staged.chars}文字）。`
            : "取り込みましたが変更はありません。",
        );
        const fetched = await fetchIsolationDiff(copyId);
        setDiffs(fetched);
        if (fetched.some((diff) => diff.drifted)) {
          setReviewStatus("文書が更新されています。選択範囲を指定し直してください。");
        }
      } catch (cause: unknown) {
        setReviewMessage(describeIsolationError(cause));
        try {
          const fetched = await fetchIsolationDiff(copyId);
          setDiffs(fetched);
        } catch {
          // Diff fetch failure already reported via staging error.
        }
      } finally {
        setReviewBusy(false);
      }
    },
    [],
  );

  // Manual retry for the staged-proposal intake (ReviewPanel button).
  // Uses the stored proposal + mode so exact scope is preserved.
  const stageStoredProposal = useCallback(async () => {
    const copyId = stagingRef.current;
    const stored = aiProposal;
    if (!copyId || !stored) return;
    if (stored.mode === "ask") {
      setReviewMessage("質問モードは表示のみです。取り込みは行いません。");
      return;
    }
    setReviewBusy(true);
    try {
      const staged = await stageProposal(copyId, stored.proposal, stored.mode);
      setReviewMessage(null);
      setReviewStatus(
        staged.updated.length > 0
          ? `${staged.updated.length} 文書に取り込みました（${staged.chars}文字）。`
          : "取り込みましたが変更はありません。",
      );
      const fetched = await fetchIsolationDiff(copyId);
      setDiffs(fetched);
      if (fetched.some((diff) => diff.drifted)) {
        setReviewStatus("文書が更新されています。選択範囲を指定し直してください。");
      }
    } catch (cause: unknown) {
      setReviewMessage(describeIsolationError(cause));
    } finally {
      setReviewBusy(false);
    }
  }, [aiProposal]);

  // Register the exact selected snapshot as an isolated staging copy.
  // Sending always pairs this registration with onProposal above.
  // Copies stay pinned by Rust until stream settlement; cancel only touches
  // settled copies, and pin refusals surface as actionable io errors.
  const registeredContextsRef = useRef<PromptContext[]>([]);

  function contextsEqual(left: PromptContext[], right: PromptContext[]): boolean {
    if (left.length !== right.length) return false;
    return left.every((context, index) => {
      const other = right[index];
      return (
        context.documentId === other.documentId &&
        context.revision === other.revision &&
        context.text === other.text &&
        context.ranges.length === other.ranges.length &&
        context.ranges.every((range, rangeIndex) => {
          const o = other.ranges[rangeIndex];
          return range.start === o.start && range.end === o.end;
        })
      );
    });
  }

  const ensureStagingFor = useCallback(
    async (wanted: PromptContext[], owner: "agent" | "inline"): Promise<{ copyId: string }> => {
      if (chatOwnerRef.current !== owner) throw { code: "session_busy" };
      if (!registry) throw new Error(READONLY_MESSAGE);
      if (wanted.length === 0) throw { code: "staging_unresolved", copy_id: "(未解決)" };
      const current = stagingRef.current;
      if (current && contextsEqual(registeredContextsRef.current, wanted)) return { copyId: current };
      if (current) await cancelIsolatedCopy(current).catch(() => undefined);
      const info = await createIsolatedCopy(wanted);
      stagingRef.current = info.copyId;
      setStaging({ copyId: info.copyId });
      registeredContextsRef.current = wanted.map((context) => ({ ...context }));
      setDiffs([]);
      setOutcomes([]);
      setReviewMessage(null);
      setReviewStatus("送信範囲を自動登録しました。");
      return { copyId: info.copyId };
    },
    [registry],
  );

  const openInlineChat = useCallback(() => {
    if (inlineBusy) { setNotice("インラインチャットの応答が終わるか、停止するまでお待ちください。"); return; }
    const doc = activeRef.current ? docsRef.current[activeRef.current] : undefined;
    if (!doc || !registry) {
      setNotice(READONLY_MESSAGE);
      return;
    }
    const sel = selections[doc.documentId] ?? { anchor: 0, head: 0 };
    const target = resolveInlineTarget(doc.text, sel.anchor, sel.head);
    setInlineSnapshot({
      documentId: doc.documentId,
      revision: doc.revision,
      ranges: [{ start: target.start, end: target.end }],
      text: target.excerpt,
    });
    setInlineKind(target.kind);
    setInlineOpen(true);
  }, [registry, selections, inlineBusy]);

  const inlineAnchor = useCallback(() => {
    const host = document.querySelector<HTMLElement>('[data-testid="editor-primary"] .cm-editor');
    if (!host) return null;
    const box = host.getBoundingClientRect();
    try {
      const view = EditorView.findFromDOM(host);
      const caret = view?.coordsAtPos(view.state.selection.main.head);
      if (caret) return { ...caret, left: Math.min(caret.left, Math.max(box.left + 12, box.right - 396)) };
    } catch { /* Editor may be rebuilding after a view switch. */ }
    return { left: box.left + 24, top: box.top + 24, bottom: box.top + 48 };
  }, []);

  const closeInlineChat = useCallback(() => {
    setInlineOpen(false);
    document.querySelector<HTMLElement>('[data-testid="editor-primary"] .cm-content')?.focus();
  }, []);

  useEffect(() => { setInlineOpen(false); }, [activeId]);

  useEffect(() => {
    // Inline chat keeps native Vim Ctrl+I (jump forward / Tab) untouched:
    // only Ctrl+Shift+I / Cmd+Shift+I opens the composer.
    const onInlineKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
      if (event.key.toLowerCase() !== "i") return;
      const target = event.target as HTMLElement | null;
      if (target && typeof target.closest === "function" && target.closest('input,textarea,select,[role="dialog"]')) return;
      event.preventDefault();
      event.stopPropagation();
      openInlineChat();
    };
    window.addEventListener("keydown", onInlineKey, true);
    return () => window.removeEventListener("keydown", onInlineKey, true);
  }, [openInlineChat]);

  useEffect(() => {
    openInlineChatRef.current = openInlineChat;
  }, [openInlineChat]);

  useEffect(() => {
    setAiDismissed(false);
  }, [activeId]);

  const fetchReviewDiff = useCallback(async () => {
    const copyId = stagingRef.current;
    if (!copyId) return;
    setReviewBusy(true);
    try {
      const fetched = await fetchIsolationDiff(copyId);
      setDiffs(fetched);
      setReviewMessage(null);
      setReviewStatus(fetched.some((diff) => diff.drifted) ? "文書が更新されています。選択範囲を指定し直してください。" : null);
    } catch (cause) {
      setReviewMessage(describeIsolationError(cause));
    } finally {
      setReviewBusy(false);
    }
  }, []);

  const clearStaging = useCallback(() => {
    setStaging(null);
    setDiffs([]);
    setOutcomes([]);
    setReviewMessage(null);
    setReviewStatus(null);
  }, []);

  const approveStaging = useCallback(async () => {
    const copyId = stagingRef.current;
    if (!copyId) return;
    if (diffs.some((diff) => diff.drifted)) {
      setReviewMessage("文書が更新されています。選択範囲を指定し直してください。");
      return;
    }
    setReviewBusy(true);
    try {
      const result = await approveIsolatedCopy(copyId);
      setOutcomes(result.outcomes);
      // Applied buffers moved in Neovim; pull fresh snapshots so the shell
      // shows the same text, then refresh mode/cursor. An unchanged scope
      // returns applied=false with no error and counts as success, not
      // failure. Only error/rollbackError/rolledBack outcomes fail; partial
      // application is never presented as all-or-nothing.
      if (registry) {
        for (const outcome of result.outcomes) {
          if (!outcome.applied) continue;
          try {
            mergeSnapshot(await registry.fetchSnapshot(outcome.documentId));
          } catch {
            // Snapshot fetch failure leaves text as-is; outcome already
            // records the applied revision.
          }
        }
        if (activeRef.current) await refreshModeCursor(activeRef.current);
      }
      const failed = result.outcomes.filter(
        (outcome) => outcome.error !== null || outcome.rollbackError !== null || outcome.rolledBack,
      );
      const appliedCount = result.outcomes.filter((outcome) => outcome.applied).length;
      const unchangedCount = result.outcomes.filter(
        (outcome) => !outcome.applied && outcome.error === null && outcome.rollbackError === null && !outcome.rolledBack,
      ).length;
      setStaging(null);
      setDiffs([]);
      setAiProposal(null);
      if (failed.length === 0) {
        setReviewMessage(null);
        setReviewStatus(
          unchangedCount > 0 && appliedCount === 0
            ? "変更はありませんでした。"
            : appliedCount > 0 && unchangedCount > 0
              ? `${appliedCount} 文書に適用し、${unchangedCount} 文書は変更なしでした。`
              : "承認して適用しました。",
        );
        setNotice("承認して適用しました。保存は保存ボタンで行います。");
      } else {
        setReviewMessage(
          `${failed.length} 文書が未適用です: ${failed.map((outcome) => `${outcome.documentId}${outcome.error ? ` (${outcome.error})` : ""}${outcome.rolledBack ? "（ロールバック済み）" : ""}${outcome.rollbackError ? `（ロールバック失敗: ${outcome.rollbackError}）` : ""}`).join(", ")}。`,
        );
        setReviewStatus("失敗時は新規コピーで再同期してください。");
        setNotice("一部が未適用です。承認結果を確認してください。");
      }
    } catch (cause) {
      setReviewMessage(describeIsolationError(cause));
      setReviewStatus("再同期して範囲を再登録してください。");
    } finally {
      setReviewBusy(false);
    }
  }, [diffs, registry, mergeSnapshot, refreshModeCursor]);

  const rejectStaging = useCallback(async () => {
    const copyId = stagingRef.current;
    if (!copyId) return;
    setReviewBusy(true);
    try {
      await rejectIsolatedCopy(copyId);
      clearStaging();
      setAiProposal(null);
      setNotice("提案を却下しました。Markdownとディスクは変更していません。");
    } catch (cause) {
      setReviewMessage(describeIsolationError(cause));
    } finally {
      setReviewBusy(false);
    }
  }, [clearStaging]);

  // Runs settle inside AiPanel.stop before this cleanup discards the copy.
  const cancelStaging = useCallback(async () => {
    const copyId = stagingRef.current;
    if (!copyId) return;
    setReviewBusy(true);
    try {
      await cancelIsolatedCopy(copyId);
      clearStaging();
      setAiProposal(null);
      setNotice("取り消しました。Markdownとディスクは変更していません。");
    } catch (cause) {
      setReviewMessage(describeIsolationError(cause));
    } finally {
      setReviewBusy(false);
    }
  }, [clearStaging]);

  // Hiding the sidebar preserves the transcript and staging: the aside stays
  // mounted and is only visually hidden, so no copy is discarded here.

  const createFile = useCallback(async () => {
    if (!registry) {
      setNotice(READONLY_MESSAGE);
      return;
    }
    const path = newFilePath.trim();
    if (path === "") {
      setNotice("ワークスペース相対のパス（例: メモ/新規.md）を入力してください。");
      return;
    }
    try {
      const open = await workspaceApi.createMarkdown(path, "");
      const doc = docFromOpen(open);
      setDocs((prev) => ({ ...prev, [doc.documentId]: doc }));
      setTabs((prev) => (prev.includes(doc.documentId) ? prev : [...prev, doc.documentId]));
      setActiveId(doc.documentId);
      setNewFileOpen(false);
      await loadEntries();
    } catch (cause) {
      setNotice(workspaceErrorText(cause));
    }
  }, [registry, newFilePath, loadEntries]);

  const renameFile = useCallback(async () => {
    if (!registry || !renameDoc) return;
    const current = docsRef.current[renameDoc];
    if (!current) return;
    const path = renamePath.trim();
    if (path === "") {
      setNotice("新しいパスを入力してください。");
      return;
    }
    try {
      const open = await workspaceApi.renameMarkdown({ documentId: renameDoc, baseRevision: current.revision }, path);
      const doc = docFromOpen(open);
      setDocs((prev) => ({ ...prev, [doc.documentId]: doc }));
      setRenameDoc(null);
      await loadEntries();
      setNotice("名前を変更しました。");
    } catch (cause) {
      setNotice(workspaceErrorText(cause));
    }
  }, [registry, renameDoc, renamePath, loadEntries]);

  const restoreEntry = useCallback(
    async (documentId: string, discard: boolean) => {
      if (!registry) return;
      try {
        if (discard) {
          await workspaceApi.discardRecovery(documentId);
        } else {
          const open = await workspaceApi.restoreRecovery(documentId);
          const doc = docFromOpen(open);
          setDocs((prev) => ({ ...prev, [doc.documentId]: doc }));
          setTabs((prev) => (prev.includes(doc.documentId) ? prev : [...prev, doc.documentId]));
          setActiveId(doc.documentId);
        }
        await refreshRecovery();
      } catch (cause) {
        setNotice(workspaceErrorText(cause));
      }
    },
    [registry, refreshRecovery],
  );

  return (
    <div data-theme={theme} data-testid="workspace-shell" style={{ "--editor-font-size": `${preferences.fontSize}px`, "--editor-line-height": preferences.lineHeight } as CSSProperties} className="flex h-dvh overflow-hidden bg-background text-foreground">
      <nav aria-label="アクティビティ" className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-border bg-card/50 py-2">
        {(
          [
            { id: "explorer", label: "エクスプローラー", icon: <Files size={17} aria-hidden="true" /> },
            { id: "search", label: "検索", icon: <Search size={17} aria-hidden="true" /> },
            { id: "outline", label: "アウトライン", icon: <ListTree size={17} aria-hidden="true" /> },
          ] as Array<{ id: SideView; label: string; icon: ReactNode }>
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setSideView((current) => (current === item.id ? null : item.id))}
            aria-pressed={sideView === item.id}
            aria-label={item.label}
            title={item.label}
            className={`rounded-md p-2 hover:bg-muted ${sideView === item.id ? "text-primary" : "text-muted-foreground"}`}
          >
            {item.icon}
          </button>
        ))}
        {desktop && (
          <button
            type="button"
            onClick={() => setShowAi((value) => !value)}
            aria-pressed={showAi}
            aria-label="AI"
            title="AI 支援"
            className={`rounded-md p-2 hover:bg-muted ${showAi ? "text-primary" : "text-muted-foreground"}`}
          >
            <Bot size={17} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          onClick={() => setSettings(true)}
          aria-label="設定表示切替"
          title="設定"
          className="mt-auto rounded p-2 text-muted-foreground hover:bg-muted"
        >
          <SettingsIcon size={17} aria-hidden="true" />
        </button>
      </nav>
      {sideView && (
        <aside className="hidden w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-card/50 py-3 md:flex" aria-label="サイドバー">
          {sideView === "explorer" && (
            <div className="flex flex-col gap-2 px-2">
              <div className="flex items-center gap-1 px-1">
                <span className="min-w-0 flex-1 truncate text-xs font-semibold tracking-wider text-muted-foreground">エクスプローラー</span>
                {desktop && (
                  <>
                    <button
                      type="button"
                      onClick={() => void pickFolderAndOpen()}
                      aria-label="フォルダーを開く"
                      title="フォルダーを開く"
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
                    >
                      <FolderOpen size={15} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setManualFolder((value) => !value)}
                      aria-expanded={manualFolder}
                      aria-label="パスを入力する"
                      title="パスを入力する"
                      className="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
                    >
                      パス
                    </button>
                  </>
                )}
              </div>
              {desktop && manualFolder && (
                <div className="flex gap-1 px-1">
                  <input
                    value={folderInput}
                    onChange={(event) => setFolderInput(event.target.value)}
                    placeholder="フォルダーの絶対パス…"
                    aria-label="開くフォルダーの絶対パス"
                    className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                  />
                  <button type="button" onClick={() => void openWorkspaceFolder(folderInput)} className="rounded-md border border-border px-2 py-1.5 text-xs">
                    開く
                  </button>
                </div>
              )}
              {desktop && wsRoot && <p className="flex items-center gap-1.5 px-2 text-xs font-medium" title={wsRoot}><FolderOpen size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" /><span className="truncate">{wsRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? wsRoot}</span></p>}
              <FileTree nodes={treeNodes} activePath={activeImage ?? active?.path ?? null} onOpenFile={(path) => void openFile(path)} />
              {desktop && !wsRoot && (
                <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
                  <p className="mb-2">フォルダーを開いてください。</p>
                  <button
                    type="button"
                    onClick={() => void pickFolderAndOpen()}
                    className="w-full rounded-md border border-border px-2 py-1.5"
                  >
                    フォルダーを開く
                  </button>
                </div>
              )}
            </div>
          )}
          {sideView === "search" && (
            <SearchPanel
              query={searchQuery}
              onQuery={setSearchQuery}
              hits={desktop ? registryHits : localHits}
              searching={searching}
              canReplace={desktop}
              replaceText={replaceText}
              onReplaceText={setReplaceText}
              onJump={(hit) => void jumpToHit(hit)}
              onReplaceOne={(hit) => void replaceOne(hit)}
              onReplaceAll={() => void replaceAllMatches()}
            />
          )}
          {sideView === "outline" && (
            <Outline
              text={active?.text ?? ""}
              onJump={(offset) => {
                if (active) void jumpToOffset(active.documentId, offset, offset);
              }}
            />
          )}
        </aside>
      )}

      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-card pr-2">
          <div className="min-w-0 flex-1">
            <Tabs tabs={tabItems} activeId={activeId} onSelect={setActiveId} onClose={(id) => void closeTab(id)} />
          </div>
          <label className="sr-only" htmlFor="view-mode-select">表示モード</label>
          <select
            id="view-mode-select"
            value={effectiveViewMode}
            disabled={!activeIsMarkdown}
            onChange={(event) => setViewMode(event.target.value as ViewMode)}
            aria-label="表示モード"
            className="h-7 max-w-36 rounded bg-transparent px-1 text-xs text-muted-foreground hover:bg-muted"
          >
            {(Object.keys(MODE_LABEL) as ViewMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {MODE_LABEL[mode]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setViewMode((mode) => mode === "split" ? "live" : "split")}
            aria-label="プレビューを横に開く"
            disabled={!activeIsMarkdown}
            aria-pressed={viewMode === "split"}
            title="プレビューを横に開く"
            className={`rounded p-1.5 hover:bg-muted ${viewMode === "split" ? "text-primary" : "text-muted-foreground"}`}
          >
            <PanelsLeftRight size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!desktop || !active}
            title={desktop ? "保存" : READONLY_MESSAGE}
            aria-label="保存"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            <Save size={15} aria-hidden="true" />
          </button>
          {desktop && (
            <button
              type="button"
              onClick={() => setShowAi((value) => !value)}
              aria-pressed={showAi}
              aria-label="AI 支援"
              title="AI 支援"
              className={`rounded-md p-1.5 hover:bg-muted ${showAi ? "text-primary" : "text-muted-foreground"}`}
            >
              <Bot size={15} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setMoreOpen((value) => !value)}
            aria-expanded={moreOpen}
            aria-label="その他の操作"
            title="その他の操作"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
          >
            <Ellipsis size={15} aria-hidden="true" />
          </button>
        </header>
        {moreOpen && (
          <div role="menu" aria-label="その他の操作" className="absolute inset-x-0 top-10 z-20 mx-auto max-w-lg rounded-lg border border-border bg-card p-3 shadow-lg">
            <p className="mb-1 text-xs font-semibold text-muted-foreground">書式</p>
            <GuiToolbar
                onFormat={(kind: FormatKind) => guiAtSelection((text, start, end) => formatRange(text, start, end, kind))}
                onCheckbox={() => {
                  const id = activeRef.current;
                  if (!id || !registry) {
                    setNotice(READONLY_MESSAGE);
                    return;
                  }
                  const current = docsRef.current[id];
                  if (!current) return;
                  const sel = selections[id] ?? { anchor: 0, head: 0 };
                  void applyEdits(id, toggleCheckbox(current.text, Math.min(sel.head, current.text.length)));
                }}
                onTable={() => {
                  const id = activeRef.current;
                  if (!id || !registry) {
                    setNotice(READONLY_MESSAGE);
                    return;
                  }
                  const current = docsRef.current[id];
                  if (!current) return;
                  const sel = selections[id] ?? { anchor: 0, head: 0 };
                  void applyEdits(id, insertTable(Math.min(sel.head, current.text.length), 2, 2));
                }}
                onTableRow={() => {
                  const id = activeRef.current;
                  if (!id || !registry) {
                    setNotice(READONLY_MESSAGE);
                    return;
                  }
                  const current = docsRef.current[id];
                  if (!current) return;
                  const sel = selections[id] ?? { anchor: 0, head: 0 };
                  try {
                    void applyEdits(id, tableAddRow(current.text, Math.min(sel.head, current.text.length)));
                  } catch (cause) {
                    setNotice(workspaceErrorText(cause));
                  }
                }}
                onTableColumn={() => {
                  const id = activeRef.current;
                  if (!id || !registry) {
                    setNotice(READONLY_MESSAGE);
                    return;
                  }
                  const current = docsRef.current[id];
                  if (!current) return;
                  const sel = selections[id] ?? { anchor: 0, head: 0 };
                  try {
                    void applyEdits(id, tableAddColumn(current.text, Math.min(sel.head, current.text.length)));
                  } catch (cause) {
                    setNotice(workspaceErrorText(cause));
                  }
                }}
                onLink={() => guiAtSelection((text, start, end) => insertLink(text, start, end, "https://example.com"))}
                onImage={() => guiAtSelection((text, start, end) => insertImage(text, start, end, "images/paste.png"))}
                onUndo={() => void handleUndo()}
                onRedo={() => void handleRedo()}
                vimMode={MODE_JA[vimMode] ?? vimMode}
                disabled={!desktop || !activeIsMarkdown}
              />
            <div role="group" aria-label="移動基準" className="mt-2 flex gap-1">
              {(["display", "source"] as NavBasis[]).map((basis) => (
                <button
                  key={basis}
                  type="button"
                  onClick={() => {
                    setNavBasis(basis);
                    setMoreOpen(false);
                  }}
                  aria-pressed={navBasis === basis}
                  title={basis === "display" ? "折り返し行の上下・行頭末は表示基準で移動します" : "上下・行頭末・単語・テキストオブジェクト・マクロは実 Neovim のVim の移動で動作します"}
                  className={`rounded-md px-2 py-1 text-xs ${navBasis === basis ? "bg-primary text-primary-foreground" : "border border-border"}`}
                >
                  {basis === "display" ? "表示行" : "Vim"}
                </button>
              ))}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-1">
              {(
                [
                  ["raw", "Neovim 画面"],
                  ["quick", "クイックオープン"],
                  ["palette", "コマンドパレット"],
                  ["inline", "インラインチャット"],
                  ["new", "新規ファイル"],
                  ["rename", "名前を変更"],
                  ["reload", "再読込"],
                  ["close", "閉じる"],
                  ["recovery", "復旧一覧"],
                  ["settings", "設定"],
                ] as Array<[string, string]>
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMoreOpen(false);
                    if (id === "raw") setShowRaw((value) => !value);
                    else if (id === "quick") setQuickOpen(true);
                    else if (id === "palette") setPalette(true);
                    else if (id === "inline") openInlineChat();
                    else if (id === "new") {
                      setNewFilePath("");
                      setNewFileOpen(true);
                    } else if (id === "rename" && activeRef.current) {
                      const current = docsRef.current[activeRef.current];
                      setRenamePath(current?.path ?? "");
                      setRenameDoc(activeRef.current);
                    } else if (id === "reload") void handleReload();
                    else if (id === "close" && activeRef.current) void closeTab(activeRef.current);
                    else if (id === "recovery") void refreshRecovery();
                    else if (id === "settings") setSettings(true);
                  }}
                  className="rounded-md border border-border px-2 py-1.5 text-left text-xs hover:bg-muted"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="min-h-0 shrink-0 space-y-2 overflow-y-auto empty:hidden">
          {notice && (
            <span role="alert" className="mb-2 block truncate rounded-md border border-border px-2 py-1 text-xs">
              {notice}
            </span>
          )}
          {activeExternal && active && (
            <div role="alert" data-testid="external-banner" className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3 text-xs">
              <span>
                {activeExternal.deleted ? "ファイルが外部で削除されました。" : "ファイルが外部で変更されました。"}
                {active.dirty ? "未保存の変更を保持しています。" : ""}
              </span>
              {!active.dirty && (
                <button type="button" onClick={() => void handleReload()} className="rounded-md border border-border px-3 py-1">
                  再読込する
                </button>
              )}
            </div>
          )}
          {isConflicted && active && (
            <div role="alert" data-testid="conflict-banner" className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3 text-xs">
              <span>保存競合: ディスクが変更されています。本文は保持しています。</span>
              <button
                type="button"
                onClick={() => {
                  const id = active.documentId;
                  const current = docsRef.current[id];
                  if (!current) return;
                  void (async () => {
                    try {
                      await workspaceApi.closeDocument({ documentId: id, baseRevision: current.revision }, "discard");
                      const open = await workspaceApi.openMarkdown(active.path ?? "");
                      const doc = docFromOpen(open);
                      setDocs((prev) => ({ ...prev, [doc.documentId]: doc }));
                      setTabs((prev) => prev.map((tab) => (tab === id ? doc.documentId : tab)));
                      setActiveId(doc.documentId);
                      setConflictDoc(null);
                      setNotice("最新のMarkdownに再読込しました（未保存の変更は破棄）。");
                    } catch (cause) {
                      setNotice(workspaceErrorText(cause));
                    }
                  })();
                }}
                className="rounded-md border border-border px-3 py-1"
              >
                再読込（未保存を破棄）
              </button>
              <button type="button" onClick={() => setConflictDoc(null)} className="rounded-md border border-border px-3 py-1">
                保持する
              </button>
            </div>
          )}
          {recovery.length > 0 && (
            <div role="alert" data-testid="recovery-banner" className="rounded-lg border border-border bg-card p-3 text-xs">
              <p className="mb-2 font-medium">前回未保存の文書があります（クラッシュ復元）。</p>
              <ul className="space-y-1">
                {recovery.map((entry) => (
                  <li key={entry.documentId} className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">
                      {entry.path ?? entry.documentId}
                      {entry.conflict ? "（ディスクも変更あり）" : ""}
                    </span>
                    <button type="button" onClick={() => void restoreEntry(entry.documentId, false)} className="rounded border border-border px-2 py-1">
                      復元する
                    </button>
                    <button type="button" onClick={() => void restoreEntry(entry.documentId, true)} className="rounded border border-border px-2 py-1">
                      破棄する
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {closeDecision && (
            <div role="dialog" aria-label="閉じる確認" data-testid="close-dialog" className="rounded-lg border border-border bg-card p-3 text-xs">
              <p className="mb-2">未保存の変更があります。どうしますか。</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => void resolveCloseDecision("save")} className="rounded-md border border-border px-3 py-1">
                  保存して閉じる
                </button>
                <button type="button" onClick={() => void resolveCloseDecision("discard")} className="rounded-md border border-border px-3 py-1">
                  破棄して閉じる
                </button>
                <button type="button" onClick={() => void resolveCloseDecision("cancel")} className="rounded-md border border-border px-3 py-1">
                  キャンセル
                </button>
              </div>
            </div>
          )}
          {newFileOpen && (
            <div role="dialog" aria-label="新規ファイル" className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3 text-xs">
              <input
                value={newFilePath}
                onChange={(event) => setNewFilePath(event.target.value)}
                placeholder="メモ/新規.md"
                aria-label="新規ファイルのパス"
                className="min-w-40 flex-1 rounded-md border border-border bg-background px-3 py-1.5"
              />
              <button type="button" onClick={() => void createFile()} className="rounded-md border border-border px-3 py-1">
                作成する
              </button>
              <button type="button" onClick={() => setNewFileOpen(false)} className="rounded-md border border-border px-3 py-1">
                閉じる
              </button>
            </div>
          )}
          {renameDoc && (
            <div role="dialog" aria-label="名前の変更" className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3 text-xs">
              <input
                value={renamePath}
                onChange={(event) => setRenamePath(event.target.value)}
                placeholder="メモ/新名.md"
                aria-label="新しいパス"
                className="min-w-40 flex-1 rounded-md border border-border bg-background px-3 py-1.5"
              />
              <button type="button" onClick={() => void renameFile()} className="rounded-md border border-border px-3 py-1">
                変更する
              </button>
              <button type="button" onClick={() => setRenameDoc(null)} className="rounded-md border border-border px-3 py-1">
                閉じる
              </button>
            </div>
          )}
        </div>

        <main
          className="grid min-h-0 min-w-0 flex-1 overflow-hidden"
          style={{ gridTemplateColumns: effectiveViewMode === "split" && activeIsMarkdown && active ? `minmax(0, ${splitRatio}fr) 5px minmax(0, ${100 - splitRatio}fr)` : "minmax(0, 1fr)" }}
          aria-label="編集領域"
        >
          {/* One editor-primary at a time: live owns the inline preview
              pane, source/split own the raw pane. Selections live in shell
              state so scroll/cursor survive mode switches. */}
          {activeImage ? <ImageViewer key={activeImage} path={activeImage} /> : active ? (
            effectiveViewMode === "live" ? (
              <ImageDropZone enabled={desktop && activeIsMarkdown} selection={dropSelection} onDrop={handleImageDrop} onError={setNotice}>
              <div onKeyDownCapture={onEditorKeyDown} onPasteCapture={onPasteCapture} className="h-full min-h-0 min-w-0">
                <CodeMirrorEditor
                  key={`live-${active.documentId}`}
                  value={active.text}
                  editable={desktop}
                  ariaLabel={`${active.path ?? active.documentId}の${activeIsMarkdown ? "Markdown" : "テキスト"}エディタ`}
                  testId="editor-primary"
                  initialSelection={selections[active.documentId] ?? null}
                  externalCursor={cursorEcho[active.documentId] ?? null}
                  livePreview
                  preferences={preferences}
                  vimMode={vimMode}
                  allowTextInput={vimMode === "insert" || vimMode === "replace"}
                  resolveImage={liveResolver}
                  onGuiEdits={(edits) => void applyEdits(active.documentId, edits)}
                  onSelectionChange={(selection) => handleSelection(active.documentId, selection)}
                />
              </div>
              </ImageDropZone>
            ) : (
              <ImageDropZone hidden={effectiveViewMode === "read"} enabled={desktop && activeIsMarkdown && effectiveViewMode !== "read"} selection={dropSelection} onDrop={handleImageDrop} onError={setNotice}>
              <div
                onKeyDownCapture={onEditorKeyDown}
                onPasteCapture={onPasteCapture}
                className={effectiveViewMode === "read" ? "hidden" : "flex h-full min-h-0 min-w-0 flex-col"}
                aria-hidden={effectiveViewMode === "read"}
              >
                {effectiveViewMode === "split" && <div className="flex h-7 shrink-0 items-center border-b border-border px-3 text-xs text-muted-foreground">Markdown</div>}
                <CodeMirrorEditor
                  key={`primary-${active.documentId}`}
                  value={active.text}
                  editable={desktop}
                  ariaLabel={`${active.path ?? active.documentId}の${activeIsMarkdown ? "Markdown" : "テキスト"}エディタ`}
                  testId="editor-primary"
                  preferences={preferences}
                  vimMode={vimMode}
                  allowTextInput={vimMode === "insert" || vimMode === "replace"}
                  initialSelection={selections[active.documentId] ?? null}
                  externalCursor={cursorEcho[active.documentId] ?? null}
                  onGuiEdits={(edits) => void applyEdits(active.documentId, edits)}
                  onSelectionChange={(selection) => handleSelection(active.documentId, selection)}
                />
              </div>
              </ImageDropZone>
            )
          ) : (
            <div className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">
              フォルダーを開き、ツリーからファイルを開いてください。
            </div>
          )}
          {effectiveViewMode === "read" && activeIsMarkdown && active && (
            <div className="min-h-0 min-w-0">
              <MarkdownPreview key={`read-${active.documentId}`} text={active.text} resolveImage={readResolver} />
            </div>
          )}
          {effectiveViewMode === "split" && active && (
            <>
              <div
                role="separator"
                aria-label="Markdown とプレビューの幅"
                aria-orientation="vertical"
                aria-valuemin={25}
                aria-valuemax={75}
                aria-valuenow={splitRatio}
                tabIndex={0}
                className="z-10 cursor-col-resize touch-none border-x border-border bg-card hover:bg-primary focus-visible:bg-primary focus-visible:outline-none"
                onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
                onPointerMove={(event) => {
                  if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                  const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
                  setSplitRatio(Math.max(25, Math.min(75, (event.clientX - bounds.left) / bounds.width * 100)));
                }}
                onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
                onDoubleClick={() => setSplitRatio(50)}
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
                  event.preventDefault();
                  setSplitRatio((ratio) => event.key === "Home" ? 50 : Math.max(25, Math.min(75, ratio + (event.key === "ArrowLeft" ? -5 : 5))));
                }}
              />
              <div className="flex min-h-0 min-w-0 flex-col" data-testid="split-preview-pane">
                <div className="flex h-7 shrink-0 items-center border-b border-border px-3 text-xs text-muted-foreground">プレビュー</div>
                <div className="min-h-0 flex-1">
                  <MarkdownPreview key={`split-${active.documentId}`} text={active.text} resolveImage={readResolver} />
                </div>
              </div>
            </>
          )}
        </main>

        {showRaw && active && (
          <div className="shrink-0 px-2 pb-2">
            <RawGridView
              text={active.text}
              revision={gridRev ?? active.revision}
              onRefresh={handleRawGridRefresh}
              grid={nvimGrid}
              onVimKeys={desktop ? handleRawGridKeys : undefined}
            />
          </div>
        )}

        <footer className="flex h-[22px] shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap border-t border-border px-2 text-[11px] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{activeImage ?? active?.path ?? "ファイルを開いてください"}</span>
          {cursorPos && <span data-testid="cursor">カーソル {cursorPos}</span>}
          {desktop && active && <span data-testid="vim-footer-mode">{MODE_JA[vimMode] ?? vimMode}</span>}
          <span data-testid="revision">リビジョン {active?.revision ?? "—"}</span>
          <span data-testid="dirty">{!active || active.dirty ? (active ? "未保存" : "—") : "保存済み"}</span>
          {desktop && vimKeys !== "" && <span data-testid="vim-keys">Vim入力 {vimKeys}</span>}
          {desktop && copyReady === activeId && <span data-testid="copy-ready">コピー: {Object.entries(copyKeys).map(([format, key]) => `${key} ${COPY_LABELS[format as keyof typeof COPY_LABELS]}`).join(" / ")}</span>}
          {!desktop && <span data-testid="readonly-note">ブラウザ表示は読み取り専用です</span>}
          <span role="status" className="shrink-0">
            {runtime ? (runtime.connection === "disconnected" ? "Neovim 未接続" : runtime.connection === "connected" ? "Neovim 接続済み" : runtime.detail) : "接続状態を確認中…"}
          </span>
        </footer>

        <QuickOpen
          open={quickOpen}
          paths={quickPaths}
          label="クイックオープン"
          testId="quick-open"
          onSelect={(path) => void openFile(path)}
          onClose={() => setQuickOpen(false)}
        />
          {inlineOpen && inlineSnapshot && active && inlineSnapshot.documentId === active.documentId && (
          <div data-testid="inline-chat-anchor">
            <InlineChat
              key={`${inlineSnapshot.documentId}:${inlineSnapshot.revision}:${inlineSnapshot.ranges[0]?.start}:${inlineSnapshot.ranges[0]?.end}`}
              anchor={inlineAnchor}
              documentId={inlineSnapshot.documentId}
              documentLabel={contextLabels[inlineSnapshot.documentId] ?? "現在の文書"}
              target={{
                start: inlineSnapshot.ranges[0]?.start ?? 0,
                end: inlineSnapshot.ranges[0]?.end ?? 0,
                kind: inlineKind,
                excerpt: inlineSnapshot.text,
              }}
              context={inlineSnapshot}
              staging={staging}
              ensureStaging={(contexts) => ensureStagingFor(contexts, "inline")}
              provider={aiProvider}
              disabled={agentBusy}
              onBusyChange={setInlineChatBusy}
              onProposal={handleProposal}
              onReview={() => { setShowAi(true); void fetchReviewDiff(); }}
              onClose={closeInlineChat}
            />
          </div>
        )}
        <CommandPalette open={palette} commands={commands} onRun={runCommand} onClose={() => setPalette(false)} />
        {settings && (
          <SettingsPanel
            theme={theme}
            onTheme={setTheme}
            preferences={preferences}
            onPreferences={updatePreferences}
            onOpenAiSettings={desktop ? () => { setSettings(false); setShowAi(true); setAiSettingsToken((token) => token + 1); } : undefined}
            configPath={configPath}
            configError={configError}
            onConfigPath={setConfigPath}
            onBrowseConfig={
              desktop
                ? () =>
                    void (async () => {
                      const picked = await pickConfigFile();
                      if (picked) setConfigPath(picked);
                    })()
                : undefined
            }
            onApplyConfig={() => void applyConfig()}
            applyingConfig={applyingConfig}
            currentConfig={currentConfig}
            copyKeys={copyKeys}
            onClose={() => setSettings(false)}
          />
        )}
      </div>

      {desktop && (
        <aside
          data-testid="ai-sidebar"
          aria-label="AI サイドバー"
          aria-hidden={!showAi}
          className={
            showAi
              ? "flex w-80 max-w-[85vw] shrink-0 flex-col border-l border-border bg-card/50 p-3"
              : "hidden"
          }
        >
          <div className="flex min-h-0 flex-1 flex-col">
          <AiPanel
            contexts={aiContexts}
            staging={staging}
            ensureStaging={(contexts) => ensureStagingFor(contexts, "agent")}
            provider={aiProvider}
            onProvider={setAiProvider}
            openSettingsToken={aiSettingsToken}
            contextLabels={contextLabels}
            disabled={inlineBusy}
            onBusyChange={setAgentChatBusy}
            onRemoveContext={() => setAiDismissed(true)}
            onProposal={handleProposal}
          />
          </div>
          <div className="mt-3 max-h-64 min-h-0 overflow-y-auto">
            <ReviewPanel
              documentLabels={contextLabels}
              copyId={staging?.copyId ?? null}
              diffs={diffs}
              outcomes={outcomes}
              busy={reviewBusy || agentBusy || inlineBusy}
              message={reviewMessage}
              status={reviewStatus}
              proposalText={aiProposal?.proposal.text ?? null}
              onFetchDiff={() => void fetchReviewDiff()}
              onStageProposal={aiProposal && aiProposal.mode !== "ask" && staging && reviewMessage ? () => void stageStoredProposal() : null}
              onApprove={() => void approveStaging()}
              onReject={() => void rejectStaging()}
              onCancel={() => void cancelStaging()}
            />
          </div>
          {aiDismissed && active && (
            <button type="button" onClick={() => setAiDismissed(false)} className="mt-2 w-full rounded-md border border-border px-3 py-1.5 text-xs">
              現在の選択を送る
            </button>
          )}
          {aiProposal && aiProposal.mode !== "ask" && (
            <details data-testid="ai-proposal" className="mt-3 max-h-48 min-h-0 overflow-y-auto border-t border-border pt-2 text-xs">
              <summary className="cursor-pointer text-muted-foreground">提案の Markdown</summary>
              <p className="font-medium">AI の提案</p>
              <p className="mt-1 whitespace-pre-wrap">{aiProposal.proposal.text}</p>
              <p
                className="mt-1 text-muted-foreground"
                title={aiProposal.proposal.baseContexts.map((ref) => `rev ${ref.revision}`).join(", ")}
              >
                対象: {aiProposal.proposal.baseContexts.map((ref) => contextLabels[ref.documentId] ?? "現在の文書").join(", ")}
              </p>
              <p className="mt-1 text-muted-foreground">適用は上の差分レビューで行います。</p>
              <button type="button" onClick={() => setAiProposal(null)} className="mt-2 w-full rounded-md border border-border px-3 py-1.5">
                却下する
              </button>
            </details>
          )}
        </aside>
      )}
    </div>
  );
}
