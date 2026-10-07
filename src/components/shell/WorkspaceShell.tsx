import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Files, Settings as SettingsIcon } from "lucide-react";
import { CodeMirrorEditor, type EditorSelection, type ExternalCursor } from "../editor/CodeMirrorEditor";
import { MarkdownPreview } from "../preview/MarkdownPreview";
import AiPanel from "../ai-panel";
import type { ContextSummary, ProposalText, PromptContext } from "../../shared/ai-contracts";
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
import { gridLineText, gridLinesFromRedraw } from "../../lib/grid";
import { offsetToLineCol } from "../../lib/utf16";

export type ViewMode = "live" | "source" | "read" | "split";
export type NavBasis = "display" | "source";

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
  const [showSidebar, setShowSidebar] = useState(true);
  const [showAi, setShowAi] = useState(false);
  const [aiDismissed, setAiDismissed] = useState(false);
  const [aiProposal, setAiProposal] = useState<{ proposal: ProposalText; sent: ContextSummary[] } | null>(null);
  const [theme, setTheme] = useState<ThemeId>("light");
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
  const [gridLines, setGridLines] = useState<string[] | null>(null);
  const [gridRev, setGridRev] = useState<number | null>(null);
  const previewWrap = useRef<HTMLDivElement>(null);

  const docsRef = useRef(docs);
  docsRef.current = docs;
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
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

  const mergeSnapshot = useCallback((snapshot: DocumentSnapshot) => {
    setDocs((prev) => {
      const doc = prev[snapshot.documentId];
      if (!doc || snapshot.revision < doc.revision) return prev;
      return { ...prev, [snapshot.documentId]: applySnapshot(doc, snapshot) };
    });
  }, []);

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
        setCursorEcho((prev) => ({ ...prev, [id]: { anchor: cursor.anchor, head: cursor.head, rev: cursor.revision } }));
      } catch {
        // Best-effort display only.
      }
    },
    [registry],
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
      const current = docsRef.current[id];
      if (!current) return;
      setVimKeys((prev) => (prev + keys).slice(-24));
      try {
        const snapshot = await registry.vimInput({ documentId: id, baseRevision: current.revision }, keys);
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
      if (!registry) return;
      const current = docsRef.current[id];
      if (!current) return;
      registry
        .reportCursor({ documentId: id, revision: current.revision, anchor: selection.anchor, head: selection.head })
        .catch(() => undefined);
    },
    [registry],
  );

  const jumpToOffset = useCallback(
    async (id: string, anchor: number, head: number) => {
      setCursorEcho((prev) => {
        const current = docsRef.current[id];
        return { ...prev, [id]: { anchor, head, rev: (current?.revision ?? 0) + 0.5 } };
      });
      if (!registry) return;
      const current = docsRef.current[id];
      if (!current) return;
      try {
        const cursor = await registry.reportCursor({ documentId: id, revision: current.revision, anchor, head });
        setCursorEcho((prev) => ({ ...prev, [id]: { anchor: cursor.anchor, head: cursor.head, rev: cursor.revision } }));
      } catch {
        // Best-effort navigation; the editor keeps its own selection.
      }
    },
    [registry],
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
      if (navRef.current === "display" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        // Display-basis vertical motion, line start/end, and keyboard
        // selection stay in the editor; word/textobject/macro keys below
        // still route natively in non-insert modes.
        if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        if ((vimModeRef.current === "insert" || vimModeRef.current === "replace") && event.key.length === 1) return;
      }
      const keys = serializeVimKey({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey });
      if (!keys) return;
      event.preventDefault();
      event.stopPropagation();
      void routeVimKeys(activeRef.current, keys);
    },
    [desktop, registry, routeVimKeys],
  );

  // -- paste images (shell level; preview pipeline untouched) ----------------

  const onEditorPaste = useCallback(
    (event: React.ClipboardEvent) => {
      if (!desktop || !registry || !activeRef.current) return;
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) => /^image\/(png|jpeg|gif|webp)$/.test(file.type));
      if (files.length === 0) return;
      const id = activeRef.current;
      const current = docsRef.current[id];
      if (!current) return;
      event.preventDefault();
      const sel = selections[id] ?? { anchor: 0, head: 0 };
      const at = Math.min(sel.head, current.text.length);
      void (async () => {
        for (const file of files) {
          if (file.size > 20 * 1024 * 1024) {
            setNotice("対応画像（PNG/JPEG/GIF/WebP、20 MiB 以下）のみ扱えます。");
            continue;
          }
          try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const result = await registry.pasteImage(
              { request: { documentId: id, baseRevision: docsRef.current[id]?.revision ?? current.revision }, name: file.name, bytes, range: { start: at, end: at } },
            );
            mergeSnapshot(result.snapshot);
            setNotice(`画像を挿入しました（${result.path}）。`);
          } catch (cause) {
            if (cause instanceof StaleResync) sayStale(cause.snapshot);
            else setNotice(workspaceErrorText(cause));
          }
        }
      })();
    },
    [desktop, registry, mergeSnapshot, sayStale, selections],
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

  const handleEvents = useCallback(
    (events: WorkspaceEvent[]) => {
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
    [mergeSnapshot],
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

  useEffect(() => {
    if (!desktop || !activeId) return;
    void refreshModeCursor(activeId);
  }, [desktop, activeId, refreshModeCursor]);

  useEffect(() => {
    if (!desktop || !activeId || !showRaw) return;
    workspaceApi
      .fetchGrid(activeId, 80, 24)
      .then((grid) => {
        const lines = gridLinesFromRedraw(grid.updates).map((line) => gridLineText(line));
        setGridLines(lines);
        setGridRev(grid.revision);
      })
      .catch((cause: unknown) => setNotice(workspaceErrorText(cause)));
  }, [desktop, activeId, showRaw, active?.revision]);

  // -- preview relative images (wrapper-level; preview pipeline untouched) ---

  const imageCache = useRef(new Map<string, string>());
  useEffect(() => {
    if (!desktop || !registry || !active) return;
    const root = previewWrap.current;
    if (!root) return;
    const images = Array.from(root.querySelectorAll("img")).filter((img) => {
      const src = img.getAttribute("src") ?? "";
      return src !== "" && !/^(https?:|data:|blob:|#)/i.test(src);
    });
    let cancelled = false;
    void (async () => {
      for (const img of images) {
        const src = img.getAttribute("src") ?? "";
        const key = `${active.documentId}:${src}`;
        const cached = imageCache.current.get(key);
        if (cached) {
          img.setAttribute("src", cached);
          continue;
        }
        try {
          const data = await workspaceApi.loadImage(active.documentId, src);
          if (cancelled) return;
          let binary = "";
          const bytes = data.bytes;
          for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
          }
          const url = `data:${data.mime};base64,${btoa(binary)}`;
          imageCache.current.set(key, url);
          img.setAttribute("src", url);
        } catch {
          // Missing images keep their alt text; no fake content is injected.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [desktop, registry, active, active?.text, active?.revision]);

  // -- config -----------------------------------------------------------------

  const applyConfig = useCallback(async () => {
    if (!registry || !activeRef.current) {
      setNotice(READONLY_MESSAGE);
      return;
    }
    const trimmed = configPath.trim();
    if (trimmed !== "" && !isSupportedConfigName(trimmed)) {
      setConfigError("対応する名前は vimrc / _vimrc / init.vim / init.lua です。");
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
      else if (id === "palette-raw-refresh") setGridLines(null);
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

  const handleProposal = useCallback((proposal: ProposalText, sent: ContextSummary[]) => {
    setAiProposal({ proposal, sent });
    setNotice("AI の提案を受け取りました。適用は差分レビュー (#8) で行います。");
  }, []);

  useEffect(() => {
    setAiDismissed(false);
  }, [activeId]);

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
    <div data-theme={theme} data-testid="workspace-shell" className="flex min-h-screen bg-background text-foreground">
      <nav aria-label="アクティビティ" className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-card/50 py-3">
        <button
          type="button"
          onClick={() => setShowSidebar((value) => !value)}
          aria-pressed={showSidebar}
          aria-label="エクスプローラー表示切替"
          title="エクスプローラー"
          className={`rounded-md p-2 hover:bg-muted ${showSidebar ? "text-primary" : "text-muted-foreground"}`}
        >
          <Files size={18} aria-hidden="true" />
        </button>
        {desktop && (
          <button
            type="button"
            onClick={() => setShowAi((value) => !value)}
            aria-pressed={showAi}
            aria-label="AI表示切替"
            title="AI 支援"
            className={`rounded-md p-2 hover:bg-muted ${showAi ? "text-primary" : "text-muted-foreground"}`}
          >
            <Bot size={18} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          onClick={() => setSettings(true)}
          aria-label="設定表示切替"
          title="設定"
          className="rounded-md p-2 text-muted-foreground hover:bg-muted"
        >
          <SettingsIcon size={18} aria-hidden="true" />
        </button>
      </nav>
      {showSidebar && (
        <aside className="hidden w-64 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-card/50 py-4 md:flex" aria-label="サイドバー">
          <FileTree nodes={treeNodes} activePath={active?.path ?? null} onOpenFile={(path) => void openFile(path)} />
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
          <Outline
            text={active?.text ?? ""}
            onJump={(offset) => {
              if (active) void jumpToOffset(active.documentId, offset, offset);
            }}
          />
        </aside>
      )}

      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <div role="group" aria-label="表示モード" className="flex gap-1">
            {(Object.keys(MODE_LABEL) as ViewMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                aria-pressed={viewMode === mode}
                className={`rounded-md px-3 py-1.5 text-sm ${viewMode === mode ? "bg-primary text-primary-foreground" : "border border-border"}`}
              >
                {MODE_LABEL[mode]}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => setShowRaw((value) => !value)} aria-pressed={showRaw} className="rounded-md border border-border px-3 py-1.5 text-sm">
            原文ビュー
          </button>
          <button type="button" onClick={() => setQuickOpen(true)} className="rounded-md border border-border px-3 py-1.5 text-sm">
            クイックオープン
          </button>
          <button type="button" onClick={() => setPalette(true)} className="rounded-md border border-border px-3 py-1.5 text-sm">
            コマンド
          </button>
          <button type="button" onClick={() => setSettings(true)} className="rounded-md border border-border px-3 py-1.5 text-sm">
            設定
          </button>
          {desktop && (
            <button
              type="button"
              onClick={() => setShowAi((value) => !value)}
              aria-pressed={showAi}
              aria-label="AI 支援"
              className={`rounded-md border border-border px-3 py-1.5 text-sm ${showAi ? "bg-primary text-primary-foreground" : ""}`}
            >
              AI
            </button>
          )}
          <div role="group" aria-label="移動基準" className="flex gap-1">
            {(["display", "source"] as NavBasis[]).map((basis) => (
              <button
                key={basis}
                type="button"
                onClick={() => setNavBasis(basis)}
                aria-pressed={navBasis === basis}
                title={basis === "display" ? "折り返し行の上下・行頭末は表示基準で移動します" : "上下・行頭末・単語・テキストオブジェクト・マクロは実 Neovim の原文基準で動作します"}
                className={`rounded-md px-2 py-1.5 text-xs ${navBasis === basis ? "bg-primary text-primary-foreground" : "border border-border"}`}
              >
                {basis === "display" ? "表示基準" : "原文基準"}
              </button>
            ))}
          </div>
          <span role="status" className="ml-auto text-xs text-muted-foreground">
            {runtime ? (runtime.connection === "disconnected" ? "Neovim 未接続" : runtime.connection === "connected" ? "Neovim 接続済み" : runtime.detail) : "接続状態を確認中…"}
          </span>
        </header>

        {desktop ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2" aria-label="フォルダー">
            <input
              value={folderInput}
              onChange={(event) => setFolderInput(event.target.value)}
              placeholder="フォルダーの絶対パス…"
              aria-label="開くフォルダーの絶対パス"
              className="min-w-40 flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
            />
            <button type="button" onClick={() => void openWorkspaceFolder(folderInput)} className="rounded-md border border-border px-3 py-1.5 text-sm">
              フォルダーを開く
            </button>
            <button
              type="button"
              onClick={() =>
                void (async () => {
                  const picked = await pickFolder();
                  if (picked) {
                    setFolderInput(picked);
                    await openWorkspaceFolder(picked);
                  }
                })()
              }
              aria-label="フォルダーを参照する"
              className="rounded-md border border-border px-3 py-1.5 text-sm"
            >
              参照…
            </button>
            {wsRoot && <span className="max-w-full truncate text-xs text-muted-foreground">{wsRoot}</span>}
          </div>
        ) : null}

        <div className="border-b border-border px-4 pt-2">
          <Tabs tabs={tabItems} activeId={activeId} onSelect={setActiveId} onClose={(id) => void closeTab(id)} />
        </div>

        <div className="space-y-3 px-4 py-3">
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
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span data-testid="revision">リビジョン {active?.revision ?? "—"}</span>
            <span data-testid="dirty">{!active || active.dirty ? (active ? "未保存" : "—") : "保存済み"}</span>
            {cursorPos && <span data-testid="cursor">カーソル {cursorPos}</span>}
            {desktop && vimKeys !== "" && <span data-testid="vim-keys">Vim入力 {vimKeys}</span>}
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!desktop}
              title={desktop ? undefined : READONLY_MESSAGE}
              className="rounded-md border border-border px-3 py-1 text-xs disabled:opacity-50"
            >
              保存
            </button>
            {!desktop && <span data-testid="readonly-note">ブラウザ表示は読み取り専用です</span>}
            {notice && (
              <span role="alert" className="rounded-md border border-border px-2 py-1">
                {notice}
              </span>
            )}
          </div>
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
        <main className={`mx-auto grid min-h-0 w-full max-w-5xl flex-1 gap-3 px-4 pb-4 ${viewMode === "split" ? "md:grid-cols-2" : ""}`} aria-label="編集領域">
          {/* One editor-primary at a time: live owns the inline preview
              pane, source/split own the raw pane. Selections live in shell
              state so scroll/cursor survive mode switches. */}
          {active ? (
            viewMode === "live" ? (
              <div ref={previewWrap} onKeyDownCapture={onEditorKeyDown} onPaste={onEditorPaste} className="min-h-80">
                <CodeMirrorEditor
                  key={`live-${active.documentId}`}
                  value={active.text}
                  editable={desktop}
                  ariaLabel={`${active.path ?? active.documentId}の原文エディタ`}
                  testId="editor-primary"
                  initialSelection={selections[active.documentId] ?? null}
                  externalCursor={cursorEcho[active.documentId] ?? null}
                  livePreview
                  onGuiEdits={(edits) => void applyEdits(active.documentId, edits)}
                  onSelectionChange={(selection) => handleSelection(active.documentId, selection)}
                />
              </div>
            ) : (
              <div
                onKeyDownCapture={onEditorKeyDown}
                onPaste={onEditorPaste}
                className={viewMode === "read" ? "hidden" : "min-h-80"}
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
            <div className="min-h-80 rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground">
              フォルダーを開き、ツリーから Markdown ファイルを開いてください。
            </div>
          )}
          {viewMode === "read" && active && (
            <div className="min-h-80" ref={previewWrap}>
              <MarkdownPreview text={active.text} />
            </div>
          )}
          {viewMode === "split" && active && (
            <div className="min-h-80">
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
          {viewMode === "source" && (
            <div className="hidden min-h-80 md:block" aria-label="原文メモ">
              <p className="rounded-lg border border-dashed border-border p-4 text-xs leading-6 text-muted-foreground">
                原文モードではエディタのみを表示します。{navBasis === "display"
                  ? "表示基準の移動（折り返し行の上下・行頭末）はエディタ既定に従います。"
                  : "上下・行頭末・単語・テキストオブジェクト・マクロは実 Neovim の原文基準で動作します。"}
                ユーザーマッピングを上書きしません。
              </p>
            </div>
          )}
        </main>

        {showRaw && active && (
          <div className="px-4 pb-4">
            <RawGridView text={active.text} lines={gridLines} revision={gridRev ?? active.revision} onRefresh={() => setGridLines(null)} />
          </div>
        )}

        <footer className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-4 py-2 text-xs text-muted-foreground">
          <span>{active?.path ?? "（未開封）"}</span>
          <span>IME は確定のみ送信（編集中の未確定文は送らない）</span>
          <span>{desktop ? "GUI 編集は範囲パッチで Neovim へ" : "ブラウザ表示は読み取り専用です"}</span>
          {desktop && <span>移動基準: {navBasis === "display" ? "表示" : "原文"}</span>}
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
          <AiPanel contexts={aiContexts} staging={null} onRemoveContext={() => setAiDismissed(true)} onProposal={handleProposal} />
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
              <p className="mt-1 text-muted-foreground">適用は差分レビュー (#8) で行います。</p>
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
