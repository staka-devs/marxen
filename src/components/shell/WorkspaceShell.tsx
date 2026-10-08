import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bot, Files, FolderOpen, ListTree, Save, Search, Settings as SettingsIcon, Ellipsis } from "lucide-react";
import { CodeMirrorEditor, type EditorSelection, type ExternalCursor } from "../editor/CodeMirrorEditor";
import { MarkdownPreview } from "../preview/MarkdownPreview";
import AiPanel from "../ai-panel";
import ReviewPanel from "../review-panel";
import type { ContextSummary, PromptMode, ProposalText, PromptContext } from "../../shared/ai-contracts";
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
import { correspondRange as correspondSnapshotRange, resolveEditRange, sliceRange } from "../../lib/selection-range";

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
  live: "ライブ",
  source: "原文",
  read: "閲覧",
  split: "分割",
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
  const [tabs, setTabs] = useState<string[]>(() => (desktop ? [] : [SAMPLE_WORKSPACE[0].path]));
  const [activeId, setActiveId] = useState<string | null>(() => (desktop ? null : SAMPLE_WORKSPACE[0].path));
  const [viewMode, setViewMode] = useState<ViewMode>("live");
  const [navBasis, setNavBasis] = useState<NavBasis>("source");
  const [showRaw, setShowRaw] = useState(false);
  const [sideView, setSideView] = useState<SideView | null>("explorer");
  const [showAi, setShowAi] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [manualFolder, setManualFolder] = useState(false);
  const [aiDismissed, setAiDismissed] = useState(false);
  const [aiProposal, setAiProposal] = useState<{ proposal: ProposalText; sent: ContextSummary[]; mode: PromptMode } | null>(null);
  const [staging, setStaging] = useState<{ copyId: string } | null>(null);
  const [stagingBasis, setStagingBasis] = useState<{ documentId: string; revision: number } | null>(null);
  const [stagingBusy, setStagingBusy] = useState(false);
  const [diffs, setDiffs] = useState<IsolationDiff[]>([]);
  const [outcomes, setOutcomes] = useState<ApproveDocOutcome[]>([]);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewMessage, setReviewMessage] = useState<string | null>(null);
  const [reviewStatus, setReviewStatus] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeId>("dark");
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

  const active: OpenDoc | null = activeId ? (docs[activeId] ?? null) : null;

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
    async (id: string) => {
      if (!registry) return;
      try {
        const mode = await registry.fetchMode(id);
        if (activeRef.current === id) setVimMode(mode.mode);
      } catch {
        // Best-effort display only.
      }
      try {
        const cursor = await registry.fetchCursor(id);
        setSelections((prev) => ({ ...prev, [id]: { anchor: cursor.anchor, head: cursor.head } }));
        caretRef.current[id] = cursor.head;
        echoCursor(id, cursor.anchor, cursor.head);
      } catch {
        // Best-effort display only.
      }
    },
    [registry, echoCursor],
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
        await loadEntries();
        const open = await workspaceApi.listDocuments();
        const next: Record<string, OpenDoc> = {};
        for (const doc of open) next[doc.snapshot.documentId] = docFromOpen(doc);
        setDocs(next);
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
      try {
        const open = await workspaceApi.openMarkdown(path);
        const doc = docFromOpen(open);
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
      try {
        const snapshot = await registry.applyEdits({ documentId: id, baseRevision: current.revision }, edits);
        mergeSnapshot(snapshot);
      } catch (cause) {
        if (cause instanceof StaleResync) sayStale(cause.snapshot);
        else setNotice(workspaceErrorText(cause));
      }
    },
    [registry, mergeSnapshot, sayStale],
  );

  const routeVimKeys = useCallback(
    async (id: string, keys: string) => {
      if (!registry) {
        setNotice(READONLY_MESSAGE);
        return;
      }
      if (!docsRef.current[id]) return;
      setVimKeys((prev) => (prev + keys).slice(-24));
      try {
        // Revision binds at queue execution inside the client, so bursts
        // order against successive acknowledgements.
        const snapshot = await registry.vimInput(id, keys);
        mergeSnapshot(snapshot);
        await refreshModeCursor(id);
      } catch (cause) {
        if (cause instanceof StaleResync) sayStale(cause.snapshot);
        else setNotice(workspaceErrorText(cause));
      }
    },
    [registry, mergeSnapshot, refreshModeCursor, sayStale],
  );

  const handleUndo = useCallback(async () => {
    if (!registry || !activeRef.current) {
      setNotice(READONLY_MESSAGE);
      return;
    }
    const id = activeRef.current;
    try {
      mergeSnapshot(await registry.undo(id));
      await refreshModeCursor(id);
    } catch (cause) {
      setNotice(workspaceErrorText(cause));
    }
  }, [registry, mergeSnapshot, refreshModeCursor]);

  const handleRedo = useCallback(async () => {
    if (!registry || !activeRef.current) {
      setNotice(READONLY_MESSAGE);
      return;
    }
    const id = activeRef.current;
    try {
      mergeSnapshot(await registry.redo(id));
      await refreshModeCursor(id);
    } catch (cause) {
      setNotice(workspaceErrorText(cause));
    }
  }, [registry, mergeSnapshot, refreshModeCursor]);

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
      setNotice("最新の原文に再読込しました。");
    } catch (cause) {
      setNotice(workspaceErrorText(cause));
    }
  }, [registry, mergeSnapshot]);

  const closeTab = useCallback(
    async (id: string) => {
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
      setSelections((prev) => ({ ...prev, [id]: selection }));
      caretRef.current[id] = selection.head;
      if (!registry) return;
      // Serialized and coalesced inside the client: rapid gestures send only
      // the latest selection and never race mutations or echo back. Mouse
      // gestures keep their anchor; the actual mode is refreshed after the
      // report so a native Visual install (740d5d5) surfaces instead of a
      // stale Normal. Insert selections stay Insert on the Rust side.
      void registry
        .stageCursor(id, selection.anchor, selection.head)
        .then(() => {
          void refreshModeCursor(id);
        })
        .catch(() => undefined);
    },
    [registry, refreshModeCursor],
  );

  const jumpToOffset = useCallback(
    async (id: string, anchor: number, head: number) => {
      echoCursor(id, anchor, head);
      if (!registry) return;
      if (!docsRef.current[id]) return;
      try {
        const cursor = await registry.reportCursorNow(id, anchor, head);
        setSelections((prev) => ({ ...prev, [id]: { anchor: cursor.anchor, head: cursor.head } }));
        echoCursor(id, cursor.anchor, cursor.head);
        await refreshModeCursor(id);
      } catch {
        // Best-effort navigation; the editor keeps its own selection.
      }
    },
    [registry, echoCursor, refreshModeCursor],
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

  /** Exact half-open range for one edit with safe-retry correspondence data. */
  const takeRange = useCallback(
    (id: string): { range: { start: number; end: number }; beforeText: string } => {
      const current = docsRef.current[id];
      const sel = selections[id] ?? { anchor: 0, head: 0 };
      const range = resolveEditRange(current?.text.length ?? 0, sel.anchor, sel.head, caretRef.current[id]);
      return { range, beforeText: sliceRange(current?.text ?? "", range) };
    },
    [selections],
  );

  /**
   * A newer revision must never silently reuse an old range: after a stale
   * rejection, retry once only when the fresh text still holds the captured
   * slice at the clamped range (collapsed carets always correspond).
   */
  const correspondRange = useCallback(
    (snapshot: DocumentSnapshot, range: { start: number; end: number }, beforeText: string): { start: number; end: number } | null =>
      correspondSnapshotRange(snapshot.text, range, beforeText),
    [],
  );

  const routeCharKey = useCallback(
    async (id: string, key: string, range: { start: number; end: number }, beforeText: string, retried = false): Promise<void> => {
      if (!registry) {
        setNotice(READONLY_MESSAGE);
        return;
      }
      if (!docsRef.current[id]) return;
      setVimKeys((prev) => (prev + key).slice(-24));
      try {
        const decision = await registry.routeCharKey(id, key, range);
        if (decision.action === "vim") {
          // Native edit (any mode): the cursor truth comes from the refresh.
          mergeSnapshot(decision.snapshot);
          await refreshModeCursor(id);
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
          if (!retried) {
            const fresh = correspondRange(cause.snapshot, range, beforeText);
            if (fresh) await routeCharKey(id, key, fresh, cause.snapshot.text.slice(fresh.start, fresh.end), true);
          }
        } else {
          setNotice(workspaceErrorText(cause));
        }
      }
    },
    [registry, mergeSnapshot, refreshModeCursor, sayStale, echoCursor, correspondRange],
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
      beforeText: string,
      retried = false,
    ): Promise<void> => {
      if (!registry) {
        setNotice(READONLY_MESSAGE);
        return;
      }
      if (!docsRef.current[id]) return;
      if (text === "") return;
      try {
        const decision = await registry.routeCapturedPaste(id, keyNotation, text, range);
        if (decision.action === "vim") {
          mergeSnapshot(decision.snapshot);
          await refreshModeCursor(id);
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
          if (!retried) {
            const fresh = correspondRange(cause.snapshot, range, beforeText);
            if (fresh) await routeCapturedPaste(id, keyNotation, text, fresh, cause.snapshot.text.slice(fresh.start, fresh.end), true);
          }
        } else {
          setNotice(workspaceErrorText(cause));
        }
      }
    },
    [registry, mergeSnapshot, refreshModeCursor, sayStale, echoCursor, correspondRange],
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
        // Every printable key enqueues immediately; the actual native mode is
        // read inside the serial queue, so fast Normal->i->characters and a
        // Visual install followed by a key never consult stale refs.
        event.preventDefault();
        event.stopPropagation();
        const id = activeRef.current;
        if (!docsRef.current[id]) return;
        const { range, beforeText } = takeRange(id);
        caretRef.current[id] = range.start + event.key.length;
        void routeCharKey(id, event.key, range, beforeText);
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
          const next = cursor.start + Math.max(inserted, 0);
          cursor = { start: next, end: next };
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
    [registry, mergeSnapshot, sayStale, echoCursor],
  );

  const onPasteCapture = useCallback(
    (event: React.ClipboardEvent) => {
      if (!desktop || !registry || !activeRef.current) return;
      const id = activeRef.current;
      if (!docsRef.current[id]) return;
      const data = event.clipboardData;
      const files = Array.from(data?.files ?? []).filter((file) => /^image\/(png|jpeg|gif|webp)$/.test(file.type));
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
        const { range, beforeText } = takeRange(id);
        void routeCapturedPaste(id, "<C-v>", text, range, beforeText);
        return;
      }
      const mode = vimModeRef.current;
      if (mode !== "insert" && mode !== "replace") return;
      // Context-menu paste in insert/replace inserts directly without
      // simulating a mapping. Prevent synchronously before CodeMirror default.
      event.preventDefault();
      event.stopPropagation();
      const { range, beforeText } = takeRange(id);
      void routeCapturedPaste(id, null, text, range, beforeText);
    },
    [desktop, registry, takeRange, pasteImageFiles, routeCapturedPaste],
  );

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
    if (!desktop || !activeId) return;
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
    if (!settings || !registry || !activeId) return;
    registry
      .fetchConfig(activeId)
      .then((config) => {
        setCurrentConfig(config.path);
        setConfigError(config.errors.length > 0 ? config.errors.join("\n") : null);
      })
      .catch(() => undefined);
  }, [settings, registry, activeId]);

  // -- palette / keys ----------------------------------------------------------

  const commands: PaletteCommand[] = useMemo(
    () => [
      { id: "view-live", label: "表示: ライブにする" },
      { id: "view-source", label: "表示: 原文にする" },
      { id: "view-read", label: "表示: 閲覧にする" },
      { id: "view-split", label: "表示: 分割にする" },
      { id: "nav-display", label: "移動: 表示基準にする" },
      { id: "nav-source", label: "移動: 原文基準にする" },
      { id: "file-new", label: "ファイル: 新規作成する" },
      { id: "file-rename", label: "ファイル: 名前を変更する" },
      { id: "file-save", label: "ファイル: 保存する" },
      { id: "file-reload", label: "ファイル: 再読込する" },
      { id: "file-close", label: "ファイル: 閉じる" },
      { id: "edit-undo", label: "編集: 元に戻す" },
      { id: "edit-redo", label: "編集: やり直す" },
      { id: "palette-quickopen", label: "移動: ファイルをすばやく開く" },
      { id: "palette-raw", label: "表示: Neovim 原文ビューを切り替える" },
      { id: "palette-raw-refresh", label: "表示: 原文ビューを更新する" },
      { id: "palette-recovery", label: "復旧: 復旧一覧を更新する" },
      { id: "palette-ai", label: "AI: AI 支援を開く" },
      { id: "palette-settings", label: "設定: 設定を開く" },
    ],
    [],
  );

  const runCommand = useCallback(
    (id: string) => {
      if (id === "view-live") setViewMode("live");
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
        return { id, label: fileLabel(doc?.path ?? null, id), dirty: doc?.dirty ?? false };
      }),
    [tabs, docs],
  );

  const quickPaths = useMemo(() => {
    const fromEntries = entries.filter((entry) => !entry.directory && entry.markdown).map((entry) => entry.path);
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

  const activeExternal = active ? externalByDoc[active.documentId] : undefined;
  const isConflicted = active ? conflictDoc === active.documentId : false;

  // Exact AI scope: the active document at its live revision with the GUI
  // selection as the single range. Dismissed per document; questions never
  // edit, and proposals only flow out through onProposal for #8 review.
  const aiContexts: PromptContext[] = useMemo(() => {
    if (!desktop || !active || aiDismissed) return [];
    const sel = selections[active.documentId] ?? { anchor: 0, head: 0 };
    const start = Math.min(sel.anchor, sel.head, active.text.length);
    const end = Math.min(Math.max(sel.anchor, sel.head), active.text.length);
    return [{ documentId: active.documentId, revision: active.revision, ranges: [{ start, end }], text: active.text }];
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
        setNotice("AI の提案を受け取りました。差分を確認してください。");
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
      setNotice("AI の提案を受け取りました。作業コピーに取り込んで差分を確認してください。");
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
          setReviewStatus("原文が動いています。範囲を再登録してから承認してください。");
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
        setReviewStatus("原文が動いています。範囲を再登録してから承認してください。");
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
  const registerStaging = useCallback(async () => {
    if (!registry) {
      setNotice(READONLY_MESSAGE);
      return;
    }
    const contexts = aiContextsRef.current;
    if (contexts.length === 0) {
      setNotice("送信範囲がありません。文書を開いて選択してください。");
      return;
    }
    setStagingBusy(true);
    try {
      if (stagingRef.current) {
        await cancelIsolatedCopy(stagingRef.current).catch(() => undefined);
      }
      const info = await createIsolatedCopy(contexts);
      setStaging({ copyId: info.copyId });
      setStagingBasis({ documentId: contexts[0].documentId, revision: contexts[0].revision });
      setDiffs([]);
      setOutcomes([]);
      setAiProposal(null);
      setReviewMessage(null);
      setReviewStatus("送信範囲を登録しました。");
    } catch (cause) {
      setNotice(describeIsolationError(cause));
    } finally {
      setStagingBusy(false);
    }
  }, [registry]);

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
      setReviewStatus(fetched.some((diff) => diff.drifted) ? "原文が動いています。範囲を再登録してから承認してください。" : null);
    } catch (cause) {
      setReviewMessage(describeIsolationError(cause));
    } finally {
      setReviewBusy(false);
    }
  }, []);

  const clearStaging = useCallback(() => {
    setStaging(null);
    setStagingBasis(null);
    setDiffs([]);
    setOutcomes([]);
    setReviewMessage(null);
    setReviewStatus(null);
  }, []);

  const approveStaging = useCallback(async () => {
    const copyId = stagingRef.current;
    if (!copyId) return;
    if (diffs.some((diff) => diff.drifted)) {
      setReviewMessage("原文が動いています。範囲を再登録してから承認してください。");
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
      setStagingBasis(null);
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
      setNotice("提案を却下しました。原文とディスクは変更していません。");
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
      setNotice("取り消しました。原文とディスクは変更していません。");
    } catch (cause) {
      setReviewMessage(describeIsolationError(cause));
    } finally {
      setReviewBusy(false);
    }
  }, [clearStaging]);

  // Closing the AI sidebar settles by discarding its unused copy.
  useEffect(() => {
    if (showAi || !stagingRef.current) return;
    const copyId = stagingRef.current;
    clearStaging();
    void cancelIsolatedCopy(copyId).catch(() => undefined);
  }, [showAi, clearStaging]);

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
    <div data-theme={theme} data-testid="workspace-shell" className="flex h-dvh overflow-hidden bg-background text-foreground">
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
          className="rounded-md p-2 text-muted-foreground hover:bg-muted"
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
              {desktop && wsRoot && <p className="truncate px-2 text-[11px] text-muted-foreground" title={wsRoot}>{wsRoot}</p>}
              <FileTree nodes={treeNodes} activePath={active?.path ?? null} onOpenFile={(path) => void openFile(path)} />
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
        <header className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
          <span className="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground" title={active?.path ?? "Marxen"}>
            {active ? (
              <>
                {fileLabel(active.path, active.documentId)}
                {active.dirty ? " ●" : ""}
              </>
            ) : (
              "Marxen"
            )}
          </span>
          <label className="sr-only" htmlFor="view-mode-select">表示モード</label>
          <select
            id="view-mode-select"
            value={viewMode}
            onChange={(event) => setViewMode(event.target.value as ViewMode)}
            aria-label="表示モード"
            className="h-7 rounded-md border border-border bg-background px-1 text-xs"
          >
            {(Object.keys(MODE_LABEL) as ViewMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {MODE_LABEL[mode]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!desktop}
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
                disabled={!desktop}
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
                  title={basis === "display" ? "折り返し行の上下・行頭末は表示基準で移動します" : "上下・行頭末・単語・テキストオブジェクト・マクロは実 Neovim の原文基準で動作します"}
                  className={`rounded-md px-2 py-1 text-xs ${navBasis === basis ? "bg-primary text-primary-foreground" : "border border-border"}`}
                >
                  {basis === "display" ? "表示基準" : "原文基準"}
                </button>
              ))}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-1">
              {(
                [
                  ["raw", "原文ビュー"],
                  ["quick", "クイックオープン"],
                  ["palette", "コマンドパレット"],
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

        <div className="border-b border-border px-2 pt-1">
          <Tabs tabs={tabItems} activeId={activeId} onSelect={setActiveId} onClose={(id) => void closeTab(id)} />
        </div>

        <div className="min-h-0 shrink-0 space-y-2 overflow-y-auto px-2 pt-2 empty:hidden">
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
                      setNotice("最新の原文に再読込しました（未保存の変更は破棄）。");
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

        {/* Live stacks editor over its rendered preview (inline live
            renderer); only split lays two panes side by side. */}
        <main className={`grid min-h-0 flex-1 gap-2 overflow-y-auto px-2 pb-2 ${viewMode === "split" ? "md:grid-cols-2" : ""}`} aria-label="編集領域">
          {/* One editor-primary at a time: live owns the inline preview
              pane, source/split own the raw pane. Selections live in shell
              state so scroll/cursor survive mode switches. */}
          {active ? (
            viewMode === "live" ? (
              <div onKeyDownCapture={onEditorKeyDown} onPasteCapture={onPasteCapture} className="min-h-0">
                <CodeMirrorEditor
                  key={`live-${active.documentId}`}
                  value={active.text}
                  editable={desktop}
                  ariaLabel={`${active.path ?? active.documentId}の原文エディタ`}
                  testId="editor-primary"
                  initialSelection={selections[active.documentId] ?? null}
                  externalCursor={cursorEcho[active.documentId] ?? null}
                  livePreview
                  resolveImage={liveResolver}
                  onGuiEdits={(edits) => void applyEdits(active.documentId, edits)}
                  onSelectionChange={(selection) => handleSelection(active.documentId, selection)}
                />
              </div>
            ) : (
              <div
                onKeyDownCapture={onEditorKeyDown}
                onPasteCapture={onPasteCapture}
                className={viewMode === "read" ? "hidden" : "min-h-0"}
                aria-hidden={viewMode === "read"}
              >
                <CodeMirrorEditor
                  key={`primary-${active.documentId}`}
                  value={active.text}
                  editable={desktop}
                  ariaLabel={`${active.path ?? active.documentId}の原文エディタ`}
                  testId="editor-primary"
                  initialSelection={selections[active.documentId] ?? null}
                  externalCursor={cursorEcho[active.documentId] ?? null}
                  onGuiEdits={(edits) => void applyEdits(active.documentId, edits)}
                  onSelectionChange={(selection) => handleSelection(active.documentId, selection)}
                />
              </div>
            )
          ) : (
            <div className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">
              フォルダーを開き、ツリーから Markdown ファイルを開いてください。
            </div>
          )}
          {viewMode === "read" && active && (
            <div className="min-h-0">
              <MarkdownPreview key={`read-${active.documentId}`} text={active.text} resolveImage={readResolver} />
            </div>
          )}
          {viewMode === "split" && active && (
            <div className="min-h-0">
              <CodeMirrorEditor
                key={`secondary-${active.documentId}`}
                value={active.text}
                editable={desktop}
                ariaLabel={`${active.path ?? active.documentId}の原文エディタ（分割右）`}
                testId="editor-secondary"
                initialSelection={selections[active.documentId] ?? null}
                externalCursor={cursorEcho[active.documentId] ?? null}
                onGuiEdits={(edits) => void applyEdits(active.documentId, edits)}
                onSelectionChange={(selection) => handleSelection(active.documentId, selection)}
              />
            </div>
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
          <span className="min-w-0 flex-1 truncate">{active?.path ?? "（未開封）"}</span>
          {cursorPos && <span data-testid="cursor">カーソル {cursorPos}</span>}
          {desktop && active && <span data-testid="vim-footer-mode">{MODE_JA[vimMode] ?? vimMode}</span>}
          <span data-testid="revision">リビジョン {active?.revision ?? "—"}</span>
          <span data-testid="dirty">{!active || active.dirty ? (active ? "未保存" : "—") : "保存済み"}</span>
          {desktop && vimKeys !== "" && <span data-testid="vim-keys">Vim入力 {vimKeys}</span>}
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
        <CommandPalette open={palette} commands={commands} onRun={runCommand} onClose={() => setPalette(false)} />
        {settings && active && (
          <SettingsPanel
            theme={theme}
            onTheme={setTheme}
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
            onClose={() => setSettings(false)}
          />
        )}
      </div>

      {showAi && desktop && (
        <aside data-testid="ai-sidebar" aria-label="AI サイドバー" className="hidden w-80 shrink-0 overflow-y-auto border-l border-border bg-card/50 p-3 md:block">
          <AiPanel contexts={aiContexts} staging={staging} onRemoveContext={() => setAiDismissed(true)} onProposal={handleProposal} />
          <div className="mt-3 rounded-lg border border-border bg-card p-3 text-xs">
            <p className="font-medium">送信範囲の登録</p>
            <p className="mt-1 text-muted-foreground">
              {staging && stagingBasis
                ? `作業コピー ${staging.copyId}（${stagingBasis.documentId} rev ${stagingBasis.revision}）`
                : "未登録。送信前に正確な範囲を登録します。"}
            </p>
            <button
              type="button"
              onClick={() => void registerStaging()}
              disabled={stagingBusy || aiContexts.length === 0}
              className="mt-2 w-full rounded-md border border-border px-3 py-1.5 disabled:opacity-50"
            >
              {stagingBusy ? "登録中…" : staging ? "範囲を再登録" : "送信範囲を登録する"}
            </button>
          </div>
          <div className="mt-3">
            <ReviewPanel
              copyId={staging?.copyId ?? null}
              diffs={diffs}
              outcomes={outcomes}
              busy={reviewBusy || stagingBusy}
              message={reviewMessage}
              status={reviewStatus}
              proposalText={aiProposal?.proposal.text ?? null}
              onFetchDiff={() => void fetchReviewDiff()}
              onStageProposal={aiProposal && staging ? () => void stageStoredProposal() : null}
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
          {aiProposal && (
            <div data-testid="ai-proposal" className="mt-3 rounded-lg border border-border bg-card p-3 text-xs">
              <p className="font-medium">AI の提案（原文は変更しません）</p>
              <p className="mt-1 whitespace-pre-wrap">{aiProposal.proposal.text}</p>
              <p className="mt-1 text-muted-foreground">
                基準: {aiProposal.proposal.baseContexts.map((ref) => `${ref.documentId} rev ${ref.revision}`).join(", ")}
              </p>
              <p className="mt-1 text-muted-foreground">適用は上の差分レビューで行います。</p>
              <button type="button" onClick={() => setAiProposal(null)} className="mt-2 w-full rounded-md border border-border px-3 py-1.5">
                却下する
              </button>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
