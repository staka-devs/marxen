import { localizedFailure, renderLocalizedText } from "../../../domain/localization";
import type { LocalizedText } from "../../../contracts/localization";
import { useI18n } from "../../i18n/I18nProvider";
// Workspace lifecycle, search, events, and native views (presentation).
//
// Owns workspace entries and roots, file create/rename/restore flows,
// revision-aware search and replace, pushed workspace events with polling
// fallback, Neovim runtime status, raw grid screens, and Neovim config
// application. All native access arrives via injected ports and the document
// session, so this hook never imports infrastructure directly.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { RecoveryEntry, RuntimeStatus, WorkspaceEntry, WorkspaceEvent } from "../../../contracts/contracts";
import type { SearchHitItem } from "../../../domain/search-hit";
import { docFromOpen, matchToHit, type OpenDoc } from "../../../application/document/document-helpers";
import {
  isSupportedConfigName,
  replaceEdits,
  searchWorkspace as searchLocal,
} from "../../../domain/workspace-content";
import { StaleResync, workspaceErrorText } from "../../../domain/document-errors";
import { applyGridUpdates, createGridState, type NvimGridState } from "../../../domain/coordinates/grid";
import type {
  DialogGateway,
  RuntimeGateway,
  WorkspaceEventSource,
  WorkspaceGateway,
} from "../../../application/ports";
import type { DocumentSession } from "./useDocumentSession";

/** Injected ports for workspace lifecycle, search, events, and views. */
export interface WorkspaceArgs {
  /** True on desktop; the browser demo searches local samples only. */
  desktop: boolean;
  /** Surface a notice without importing shell state. */
  notify: (message: LocalizedText | null) => void;
  /** Document session owning docs, tabs, selections, and snapshots. */
  session: DocumentSession;
  /** Workspace file gateway for entries, files, search, and recovery. */
  workspaceGateway?: WorkspaceGateway;
  /** Pushed workspace event subscription with polling fallback. */
  eventSource?: WorkspaceEventSource;
  /** Runtime connectivity status gateway. */
  runtimeGateway?: RuntimeGateway;
  /** Native folder and config pickers. */
  dialogGateway?: DialogGateway;
  /** Whether the raw Neovim grid view is visible. */
  showRaw: boolean;
  /** Whether the settings dialog is open (refreshes config display). */
  settingsOpen: boolean;
  /** Vim key router for raw grid input. */
  routeVimKeys: (id: string, keys: string) => Promise<void>;
  /** Called after a workspace opens so the shell can reset folder UI. */
  onWorkspaceOpened?: () => void;
}

/** Workspace lifecycle state and operations. */
export interface Workspace {
  /** Open workspace root, or null when no folder is open. */
  wsRoot: string | null;
  /** Replace the workspace root. */
  setWsRoot: React.Dispatch<React.SetStateAction<string | null>>;
  /** Flat workspace entries for the tree. */
  entries: WorkspaceEntry[];
  /** Replace the workspace entries. */
  setEntries: React.Dispatch<React.SetStateAction<WorkspaceEntry[]>>;
  /** Crash-recovery entries for the banner. */
  recovery: RecoveryEntry[];
  /** Search query for registry and local search. */
  searchQuery: string;
  /** Replace the search query. */
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  /** Registry search hits for the panel. */
  registryHits: SearchHitItem[];
  /** Whether a debounced registry search is in flight. */
  searching: boolean;
  /** Replacement text for search-and-replace. */
  replaceText: string;
  /** Replace the replacement text. */
  setReplaceText: React.Dispatch<React.SetStateAction<string>>;
  /** Local demo hits for the browser search panel. */
  localHits: SearchHitItem[];
  /** Native runtime status for the footer. */
  runtime: RuntimeStatus | null;
  /** Raw Neovim grid state for the raw view. */
  nvimGrid: NvimGridState | null;
  /** Grid revision for display. */
  gridRev: number | null;
  /** Neovim config file path input. */
  configPath: string;
  /** Replace the config path input. */
  setConfigPath: React.Dispatch<React.SetStateAction<string>>;
  /** Config validation or apply errors. */
  configError: string | null;
  /** Whether a config apply is in flight. */
  applyingConfig: boolean;
  /** Current applied config path display. */
  currentConfig: string | null;
  /** Copy format key selectors from the native config. */
  copyKeys: Record<string, string>;
  /** New-file dialog visibility. */
  newFileOpen: boolean;
  /** Replace the new-file dialog visibility. */
  setNewFileOpen: React.Dispatch<React.SetStateAction<boolean>>;
  /** New-file path input. */
  newFilePath: string;
  /** Replace the new-file path input. */
  setNewFilePath: React.Dispatch<React.SetStateAction<string>>;
  /** Document ID awaiting rename, if any. */
  renameDoc: string | null;
  /** Replace the rename target. */
  setRenameDoc: React.Dispatch<React.SetStateAction<string | null>>;
  /** Rename destination input. */
  renamePath: string;
  /** Replace the rename destination input. */
  setRenamePath: React.Dispatch<React.SetStateAction<string>>;
  /** Load all workspace entries recursively up to 2000 items. */
  loadEntries: () => Promise<WorkspaceEntry[]>;
  /** Refresh crash-recovery entries or notice on failure. */
  refreshRecovery: () => Promise<void>;
  /** Open a workspace root and load entries, docs, and recovery. */
  openWorkspaceFolder: (path: string) => Promise<void>;
  /** Pick a folder natively and open it, staying read-only in browser. */
  pickFolderAndOpen: () => Promise<void>;
  /** Create a Markdown file from the dialog path and open it. */
  createFile: () => Promise<void>;
  /** Rename the dialog document keeping its ID. */
  renameFile: () => Promise<void>;
  /** Restore or discard a crash-recovery entry by ID. */
  restoreEntry: (documentId: string, discard: boolean) => Promise<void>;
  /** Jump to a search hit opening the document when needed. */
  jumpToHit: (hit: SearchHitItem) => Promise<void>;
  /** Replace one hit revision-aware with resync on stale. */
  replaceOne: (hit: SearchHitItem) => Promise<void>;
  /** Replace all registry hits per file with chained revisions. */
  replaceAllMatches: () => Promise<void>;
  /** Refresh Neovim runtime status with error fallback. */
  refreshRuntime: () => void;
  /** Forward raw grid keys through Vim routing. */
  handleRawGridKeys: (keys: string) => void;
  /** Refetch the Neovim grid screen resetting rows. */
  handleRawGridRefresh: () => void;
  /** Apply a Neovim config restarting the actor with Undo reset. */
  applyConfig: () => Promise<void>;
}

/**
 * Own workspace lifecycle: entries, files, search, events, runtime, grid.
 *
 * Returns workspace state plus file, search, event, and view operations;
 * the document session keeps docs and tabs, composed through explicit ports.
 */
export function useWorkspace(args: WorkspaceArgs): Workspace {
  const { t, message } = useI18n();
  const { desktop, notify, session, workspaceGateway, eventSource, runtimeGateway, dialogGateway, showRaw, settingsOpen, routeVimKeys, onWorkspaceOpened } = args;
  const setNotice = notify;
  const {
    registry,
    docs,
    setDocs,
    docsRef,
    activeRef,
    setTabs,
    setActiveId,
    activeId,
    active,
    mergeSnapshot,
    sayStale,
    jumpToOffset,
    refreshModeCursor,
    setExternalByDoc,
  } = session;

  const [wsRoot, setWsRoot] = useState<string | null>(null);
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [recovery, setRecovery] = useState<RecoveryEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [registryHits, setRegistryHits] = useState<SearchHitItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [replaceText, setReplaceText] = useState("");
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [nvimGrid, setNvimGrid] = useState<NvimGridState | null>(null);
  const [gridRev, setGridRev] = useState<number | null>(null);
  const [configPath, setConfigPath] = useState("");
  const [configError, setConfigError] = useState<LocalizedText | null>(null);
  const [applyingConfig, setApplyingConfig] = useState(false);
  const [currentConfig, setCurrentConfig] = useState<string | null>(null);
  const [copyKeys, setCopyKeys] = useState<Record<string, string>>({
    markdown: "<F6>", text: "<F7>", rich: "<F8>", html: "<F9>",
  });
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");
  const [renameDoc, setRenameDoc] = useState<string | null>(null);
  const [renamePath, setRenamePath] = useState("");

  /** Load all workspace entries recursively up to 2000 items. */
  const loadEntries = useCallback(async (): Promise<WorkspaceEntry[]> => {
    const root = await workspaceGateway!.listWorkspace("");
    const all = [...root];
    const queue = root.filter((entry) => entry.directory).map((entry) => entry.path);
    const seen = new Set<string>(queue);
    while (queue.length > 0) {
      const dir = queue.shift()!;
      try {
        const children = await workspaceGateway!.listWorkspace(dir);
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
  }, [workspaceGateway]);

  /** Refresh crash-recovery entries or notice on failure. */
  const refreshRecovery = useCallback(async () => {
    if (!registry) return;
    try {
      setRecovery(await workspaceGateway!.listRecovery());
    } catch (cause) {
      setNotice(localizedFailure(cause, workspaceErrorText));
    }
  }, [registry, workspaceGateway, notify]);

  /** Open a workspace root and load entries, docs, and recovery. */
  const openWorkspaceFolder = useCallback(
    async (path: string) => {
      if (!registry) {
        setNotice(message("ブラウザ表示では編集できません。デスクトップで開いてください。"));
        return;
      }
      const trimmed = path.trim();
      if (trimmed === "") {
        setNotice(message("フォルダーの絶対パスを入力してください。"));
        return;
      }
      try {
        const info = await workspaceGateway!.openWorkspace(trimmed);
        setWsRoot(info.root);
        onWorkspaceOpened?.();
        await loadEntries();
        const open = await workspaceGateway!.listDocuments();
        const next: Record<string, OpenDoc> = {};
        for (const doc of open) {
          if (registry) registry.noteSnapshot(doc.snapshot);
          next[doc.snapshot.documentId] = docFromOpen(doc);
        }
        setDocs(next);
        setTabs(open.map((doc) => doc.snapshot.documentId));
        setActiveId(open.map((doc) => doc.snapshot.documentId)[0] ?? null);
        setExternalByDoc({});
        await refreshRecovery();
        setNotice(null);
      } catch (cause) {
        setNotice(localizedFailure(cause, workspaceErrorText));
      }
    },
    [registry, workspaceGateway, loadEntries, refreshRecovery, setDocs, setTabs, setActiveId, setExternalByDoc, onWorkspaceOpened, notify],
  );

  // Note: the manual-folder toggle and folder input stay in the shell layout;
  // this hook exposes the opener for both the picker button and the input.
  /** Pick a folder natively and open it, staying read-only in browser. */
  const pickFolderAndOpen = useCallback(async () => {
    if (!registry) {
      setNotice(message("ブラウザ表示では編集できません。デスクトップで開いてください。"));
      return;
    }
    const picked = await dialogGateway!.pickFolder(t("フォルダーを開く"));
    if (picked) await openWorkspaceFolder(picked);
  }, [registry, dialogGateway, openWorkspaceFolder, notify]);

  /** Create a Markdown file from the dialog path and open it. */
  const createFile = useCallback(async () => {
    if (!registry) {
      setNotice(message("ブラウザ表示では編集できません。デスクトップで開いてください。"));
      return;
    }
    const path = newFilePath.trim();
    if (path === "") {
      setNotice(message("ワークスペース相対のパス（例: メモ/新規.md）を入力してください。"));
      return;
    }
    try {
      const open = await workspaceGateway!.createMarkdown(path, "");
      const doc = docFromOpen(open);
      setDocs((prev) => ({ ...prev, [doc.documentId]: doc }));
      setTabs((prev) => (prev.includes(doc.documentId) ? prev : [...prev, doc.documentId]));
      setActiveId(doc.documentId);
      setNewFileOpen(false);
      await loadEntries();
    } catch (cause) {
      setNotice(localizedFailure(cause, workspaceErrorText));
    }
  }, [registry, workspaceGateway, newFilePath, loadEntries, setDocs, setTabs, setActiveId, notify]);

  /** Rename the dialog document keeping its ID. */
  const renameFile = useCallback(async () => {
    if (!registry || !renameDoc) return;
    const current = docsRef.current[renameDoc];
    if (!current) return;
    const path = renamePath.trim();
    if (path === "") {
      setNotice(message("新しいパスを入力してください。"));
      return;
    }
    try {
      const open = await workspaceGateway!.renameMarkdown({ documentId: renameDoc, baseRevision: current.revision }, path);
      const doc = docFromOpen(open);
      setDocs((prev) => ({ ...prev, [doc.documentId]: doc }));
      setRenameDoc(null);
      await loadEntries();
      setNotice(message("名前を変更しました。"));
    } catch (cause) {
      setNotice(localizedFailure(cause, workspaceErrorText));
    }
  }, [registry, workspaceGateway, renameDoc, renamePath, loadEntries, docsRef, setDocs, notify]);

  /** Restore or discard a crash-recovery entry by ID. */
  const restoreEntry = useCallback(
    async (documentId: string, discard: boolean) => {
      if (!registry) return;
      try {
        if (discard) {
          await workspaceGateway!.discardRecovery(documentId);
        } else {
          const open = await workspaceGateway!.restoreRecovery(documentId);
          const doc = docFromOpen(open);
          setDocs((prev) => ({ ...prev, [doc.documentId]: doc }));
          setTabs((prev) => (prev.includes(doc.documentId) ? prev : [...prev, doc.documentId]));
          setActiveId(doc.documentId);
        }
        await refreshRecovery();
      } catch (cause) {
        setNotice(localizedFailure(cause, workspaceErrorText));
      }
    },
    [registry, workspaceGateway, refreshRecovery, setDocs, setTabs, setActiveId, notify],
  );

  useEffect(() => {
    if (!desktop || !wsRoot) return;
    if (searchQuery === "") {
      setRegistryHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      workspaceGateway!
        .searchWorkspace(searchQuery)
        .then((matches) => setRegistryHits(matches.map(matchToHit)))
        .catch((cause: unknown) => setNotice(localizedFailure(cause, workspaceErrorText)))
        .finally(() => setSearching(false));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [desktop, wsRoot, searchQuery, workspaceGateway, notify]);

  /** Local demo hits for the browser search panel. */
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

  /** Jump to a search hit opening the document when needed. */
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
          const open = await workspaceGateway!.openMarkdown(hit.path);
          const doc = docFromOpen(open);
          if (registry) registry.noteSnapshot(open.snapshot);
          setDocs((prev) => ({ ...prev, [doc.documentId]: doc }));
          setTabs((prev) => (prev.includes(doc.documentId) ? prev : [...prev, doc.documentId]));
          id = doc.documentId;
        } catch (cause) {
          setNotice(localizedFailure(cause, workspaceErrorText));
          return;
        }
      } else {
        setTabs((prev) => (prev.includes(id!) ? prev : [...prev, id!]));
      }
      setActiveId(id);
      const start = hit.offset ?? 0;
      await jumpToOffset(id, start, hit.end ?? start);
    },
    [desktop, registry, workspaceGateway, jumpToOffset, setDocs, setTabs, setActiveId, notify],
  );

  /** Replace one hit revision-aware with resync on stale. */
  const replaceOne = useCallback(
    async (hit: SearchHitItem) => {
      if (!registry) {
        setNotice(message("ブラウザ表示では編集できません。デスクトップで開いてください。"));
        return;
      }
      if (searchQuery === "") return;
      let id = hit.documentId ?? null;
      try {
        if (!id) {
          const open = await workspaceGateway!.openMarkdown(hit.path);
          const doc = docFromOpen(open);
          if (registry) registry.noteSnapshot(open.snapshot);
          setDocs((prev) => ({ ...prev, [doc.documentId]: doc }));
          setTabs((prev) => (prev.includes(doc.documentId) ? prev : [...prev, doc.documentId]));
          id = doc.documentId;
        }
        const snapshot = await workspaceGateway!.fetchSnapshot(id);
        mergeSnapshot(snapshot);
        const { edits, count } = replaceEdits(snapshot.text, searchQuery, replaceText);
        const single = edits.find((edit) => edit.range.start <= (hit.offset ?? 0) && (hit.offset ?? 0) < edit.range.end + searchQuery.length);
        const chosen = single ? [single] : [];
        if (chosen.length === 0 || count === 0) {
          setNotice(message("置換対象が見つかりませんでした。検索し直してください。"));
          return;
        }
        const next = await registry.applyEdits({ documentId: id, baseRevision: snapshot.revision }, chosen);
        mergeSnapshot(next);
        const refreshed = await workspaceGateway!.searchWorkspace(searchQuery);
        setRegistryHits(refreshed.map(matchToHit));
      } catch (cause) {
        if (cause instanceof StaleResync) sayStale(cause.snapshot);
        else setNotice(localizedFailure(cause, workspaceErrorText));
      }
    },
    [registry, workspaceGateway, searchQuery, replaceText, mergeSnapshot, sayStale, setDocs, setTabs, notify],
  );

  /** Replace all registry hits per file with chained revisions. */
  const replaceAllMatches = useCallback(async () => {
    if (!registry) {
      setNotice(message("ブラウザ表示では編集できません。デスクトップで開いてください。"));
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
        const open = await workspaceGateway!.openMarkdown(path);
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
        else setNotice(localizedFailure(cause, workspaceErrorText));
        return;
      }
    }
    setNotice(message("{{count}} 件を置換しました。", { count: (total) }));
    try {
      setRegistryHits((await workspaceGateway!.searchWorkspace(searchQuery)).map(matchToHit));
    } catch {
      // Count notice already shown; refresh is best-effort.
    }
  }, [registry, workspaceGateway, registryHits, searchQuery, replaceText, mergeSnapshot, sayStale, setDocs, setTabs, notify]);

  // -- events / recovery -----------------------------------------------------

  // Native status must follow documents, not mount time: an empty workspace
  // reads disconnected while an open document reads connected, and a process
  // crash flips back through the event path below.
  /** Refresh Neovim runtime status with error fallback. */
  const refreshRuntime = useCallback(() => {
    runtimeGateway!.readStatus()
      .then(setRuntime)
      .catch(() => setRuntime({ contractVersion: 1, connection: "error", detail: t("接続状態を取得できません。") }));
  }, [runtimeGateway]);

  /** Handle pushed workspace events for external, snapshot, and errors. */
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
          setNotice(message("文書エラー: {{value0}}", { value0: (localizedFailure(event.payload.error, workspaceErrorText)) }));
        }
      }
    },
    [mergeSnapshot, refreshRuntime, setDocs, setExternalByDoc, notify],
  );

  useEffect(() => {
    if (!desktop || !wsRoot) return;
    let stop: (() => void) | undefined;
    eventSource!.listen(handleEvents).then((unlisten) => {
      stop = unlisten;
    });
    const timer = window.setInterval(() => {
      workspaceGateway!.pollEvents().then(handleEvents).catch(() => undefined);
    }, 4000);
    return () => {
      window.clearInterval(timer);
      stop?.();
    };
  }, [desktop, wsRoot, handleEvents, eventSource, workspaceGateway]);

  useEffect(() => {
    let active = true;
    runtimeGateway!.readStatus()
      .then((status) => {
        if (active) setRuntime(status);
      })
      .catch(() => {
        if (active) setRuntime({ contractVersion: 1, connection: "error", detail: t("接続状態を取得できません。") });
      });
    return () => {
      active = false;
    };
  }, [runtimeGateway]);

  // Native status refreshes with documents and workspace root; the mount
  // read above only seeds the first paint.
  useEffect(() => {
    if (desktop) refreshRuntime();
  }, [desktop, activeId, active?.revision, wsRoot, refreshRuntime]);

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
    workspaceGateway!
      .fetchGrid(activeId, 80, 24)
      .then((grid) => {
        if (cancelled) return;
        setNvimGrid((prev) => applyGridUpdates(prev ?? createGridState(), grid.updates));
        setGridRev(grid.revision);
      })
      .catch((cause: unknown) => setNotice(localizedFailure(cause, workspaceErrorText)));
    return () => {
      cancelled = true;
    };
  }, [desktop, activeId, showRaw, active?.revision, workspaceGateway, notify]);

  /** Forward raw grid keys through Vim routing. */
  const handleRawGridKeys = useCallback(
    (keys: string) => {
      const id = activeRef.current;
      if (id) void routeVimKeys(id, keys);
    },
    [routeVimKeys, activeRef],
  );

  /** Refetch the Neovim grid screen resetting rows. */
  const handleRawGridRefresh = useCallback(() => {
    const id = activeRef.current;
    if (!id || !desktop) return;
    setNvimGrid(createGridState());
    workspaceGateway!
      .fetchGrid(id, 80, 24)
      .then((grid) => {
        setNvimGrid((prev) => applyGridUpdates(prev ?? createGridState(), grid.updates));
        setGridRev(grid.revision);
      })
      .catch((cause: unknown) => setNotice(localizedFailure(cause, workspaceErrorText)));
  }, [desktop, workspaceGateway, activeRef, notify]);

  // -- config -----------------------------------------------------------------

  /** Apply a Neovim config restarting the actor with Undo reset. */
  const applyConfig = useCallback(async () => {
    if (!registry || !activeRef.current) {
      setNotice(message("ブラウザ表示では編集できません。デスクトップで開いてください。"));
      return;
    }
    const trimmed = configPath.trim();
    if (trimmed !== "" && !isSupportedConfigName(trimmed)) {
      setConfigError(message("対応する名前は vimrc / _vimrc / .vimrc / init.vim / init.lua です。"));
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
      setNotice(message("設定を適用して再起動しました（Undo・モードは初期化）。"));
    } catch (cause) {
      if (cause instanceof StaleResync) sayStale(cause.snapshot);
      else setNotice(localizedFailure(cause, workspaceErrorText));
    } finally {
      setApplyingConfig(false);
    }
  }, [registry, workspaceGateway, configPath, mergeSnapshot, refreshModeCursor, sayStale, docsRef, activeRef, notify]);

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
  }, [settingsOpen, registry, activeId, docsRef]);

  return {
    wsRoot,
    setWsRoot,
    entries: entries as WorkspaceEntry[],
    setEntries,
    recovery,
    searchQuery,
    setSearchQuery,
    registryHits,
    searching,
    replaceText,
    setReplaceText,
    localHits,
    runtime,
    nvimGrid,
    gridRev,
    configPath,
    setConfigPath,
    configError: configError === null ? null : renderLocalizedText(configError, t),
    applyingConfig,
    currentConfig,
    copyKeys,
    newFileOpen,
    setNewFileOpen,
    newFilePath,
    setNewFilePath,
    renameDoc,
    setRenameDoc,
    renamePath,
    setRenamePath,
    loadEntries,
    refreshRecovery,
    openWorkspaceFolder,
    pickFolderAndOpen,
    createFile,
    renameFile,
    restoreEntry,
    jumpToHit,
    replaceOne,
    replaceAllMatches,
    refreshRuntime,
    handleRawGridKeys,
    handleRawGridRefresh,
    applyConfig,
  };
}

/** Return type of the workspace hook for shell composition. */
export type WorkspaceHandle = ReturnType<typeof useWorkspace>;

