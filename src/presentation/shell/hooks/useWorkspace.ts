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

import { useCallback, useEffect, useRef, useState } from "react";
import type { SaveRequest, RecoveryEntry, RuntimeStatus, SearchOptions, SearchLimit, WorkspaceEntry, WorkspaceEvent } from "../../../contracts/contracts";
import type { ExplorerTarget } from "../../../contracts/workbench";
import type { SearchHitItem } from "../../../domain/search-hit";
import { docFromOpen, type OpenDoc } from "../../../application/document/document-helpers";
import {
  isSupportedConfigName,
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
import { useWorkspaceSearch } from "./useWorkspaceSearch";

/** Captured rename source across documents, images, and folders with its tree context. */
type RenameRequest =
  | { kind: "document"; request: SaveRequest; generation: number; source: string; target: ExplorerTarget }
  | { kind: "image"; source: string; generation: number; fingerprint: string; target: ExplorerTarget }
  | { kind: "folder"; source: string; generation: number; target: ExplorerTarget };

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
  busy: boolean;
  generation: number;
  refreshing: boolean;
  entryKind: "file" | "folder";
  createdTarget: ExplorerTarget | null;
  /** Capture a relative tree location in the current root generation. */
  targetFor: (path?: string, directory?: boolean, kind?: WorkspaceEntry["kind"]) => ExplorerTarget;
  /** Check that a captured target still belongs to this root session. */
  isTargetCurrent: (target: ExplorerTarget) => boolean;
  /** Recheck lifecycle availability synchronously before executing an operation. */
  canOperate: () => boolean;
  /** Open a contextual creation dialog under its captured parent. */
  beginCreate: (target: ExplorerTarget, folder?: boolean) => void;
  /** Open a captured text, image, or folder rename dialog. */
  beginRename: (target: ExplorerTarget) => Promise<void>;
  /** Refresh the tree while preserving authoritative dirty buffers. */
  refreshEntries: () => Promise<void>;
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
  /** Native search options wired to the real panel. */
  searchOptions: SearchOptions;
  /** Update native matching flags and invalidate obsolete work. */
  setSearchOptions: (options: SearchOptions) => void;
  /** Localized native query errors. */
  searchError: string | null;
  /** Explicit incomplete result reason. */
  searchLimit: SearchLimit | null;
  /** Whether native results can authorize actions. */
  resultsReady: boolean;
  /** Whether a serialized replacement is active. */
  replacing: boolean;
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
  /** Document ID or `image:`/`folder:` source awaiting rename, if any. */
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
  /** Rename the dialog target keeping document IDs and updating tabs. */
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
    setDocs,
    docsRef,
    activeRef,
    setTabs,
    setActiveId,
    setImageTabs,
    activeId,
    active,
    mergeSnapshot,
    sayStale,
    refreshModeCursor,
    setExternalByDoc,
  } = session;

  const [wsRoot, setWsRootState] = useState<string | null>(null);
  const search = useWorkspaceSearch({ desktop, root: wsRoot, gateway: workspaceGateway, session, notify });
  /** Fence search work before changing workspace identity. */
  const setWsRoot = useCallback((value: React.SetStateAction<string | null>) => { search.invalidate(); setWsRootState(value); }, [search.invalidate]);
  const rootRef = useRef<string | null>(null);
  const generation = useRef(0);
  const listing = useRef(0);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [entryKind, setEntryKind] = useState<"file" | "folder">("file");
  const creationTarget = useRef<ExplorerTarget | null>(null);
  const [createdTarget, setCreatedTarget] = useState<ExplorerTarget | null>(null);
  const renameRequest = useRef<RenameRequest | null>(null);
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [recovery, setRecovery] = useState<RecoveryEntry[]>([]);
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
    const epoch = generation.current;
    const ticket = ++listing.current;
    const root = await workspaceGateway!.listWorkspace("");
    if (epoch !== generation.current) return [];
    const all = [...root];
    const queue = root.filter((entry) => entry.directory).map((entry) => entry.path);
    const seen = new Set<string>(queue);
    while (queue.length > 0) {
      const dir = queue.shift()!;
      try {
        const children = await workspaceGateway!.listWorkspace(dir);
        if (epoch !== generation.current) return [];
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
    if (epoch === generation.current && ticket === listing.current) setEntries(all);
    return all;
  }, [workspaceGateway]);

  /** Capture a location in this single-root session before focus or active tabs change. */
  const targetFor = useCallback((path = "", directory = true, kind?: WorkspaceEntry["kind"]): ExplorerTarget => ({ rootId: rootRef.current ?? "", generation: generation.current, path, directory, kind }), []);
  /** Reject targets captured in a replaced workspace, including pending dialogs. */
  const isTargetCurrent = useCallback((target: ExplorerTarget) => target.rootId !== "" && target.rootId === rootRef.current && target.generation === generation.current, []);
  /** Recheck native lifecycle availability synchronously before every invocation. */
  const canOperate = useCallback(() => desktop && !!registry && !!workspaceGateway && !busyRef.current, [desktop, registry, workspaceGateway]);
  /** Refresh only the tree, preserving buffers and discarding results from replaced roots. */
  const refreshEntries = useCallback(async () => {
    if (!canOperate() || !rootRef.current) return;
    const epoch = generation.current;
    setRefreshing(true);
    try { await loadEntries(); }
    catch (cause) { if (epoch === generation.current) setNotice(localizedFailure(cause, workspaceErrorText)); }
    finally { if (epoch === generation.current) setRefreshing(false); }
  }, [canOperate, loadEntries, notify]);

  /** Start a file or folder dialog beneath the captured folder or file's parent. */
  const beginCreate = useCallback((target: ExplorerTarget, folder = false) => {
    if (!canOperate() || !isTargetCurrent(target)) return;
    const parent = target.directory ? target.path : target.path.slice(0, Math.max(0, target.path.lastIndexOf("/")));
    creationTarget.current = target;
    setEntryKind(folder ? "folder" : "file");
    setNewFilePath(parent ? `${parent}/` : "");
    setNewFileOpen(true);
  }, [canOperate, isTargetCurrent]);

  /** Capture a tree target for the rename dialog across documents, images, and folders. */
  const beginRename = useCallback(async (target: ExplorerTarget) => {
    if (!canOperate() || !isTargetCurrent(target)) return;
    if (target.directory && target.path === "") {
      setNotice(message("ルートフォルダーの名前は変更できません。"));
      return;
    }
    if (target.directory) {
      const prefix = `${target.path}/`;
      const blocked = Object.values(docsRef.current).some((doc) => doc.path !== null && (doc.path === target.path || doc.path.startsWith(prefix)));
      if (blocked) {
        setNotice(message("フォルダー内に開いた文書があるため名前を変更できません。"));
        return;
      }
      renameRequest.current = { kind: "folder", source: target.path, generation: generation.current, target };
      setRenamePath(target.path);
      setRenameDoc(`folder:${target.path}`);
      return;
    }
    if (target.kind === "image") {
      const epoch = generation.current;
      busyRef.current = true; setBusy(true);
      try {
        const data = await workspaceGateway!.loadWorkspaceImage(target.path);
        if (epoch !== generation.current || !isTargetCurrent(target)) return;
        const fingerprint = data.fingerprint;
        if (!/^[a-f0-9]{64}$/.test(fingerprint ?? "")) throw { code: "invalid_image" };
        renameRequest.current = { kind: "image", source: target.path, generation: epoch, fingerprint, target };
        setRenamePath(target.path);
        setRenameDoc(`image:${target.path}`);
      } catch (cause) { if (epoch === generation.current) setNotice(localizedFailure(cause, workspaceErrorText)); }
      finally { busyRef.current = false; setBusy(false); }
      return;
    }
    if (target.kind !== "markdown" && target.kind !== "text") return;
    const epoch = generation.current;
    busyRef.current = true; setBusy(true);
    try {
      let doc = Object.values(docsRef.current).find((item) => item.path === target.path);
      if (!doc) {
        const open = target.kind === "text"
          ? await workspaceGateway!.openTextFile(target.path)
          : await workspaceGateway!.openMarkdown(target.path);
        if (epoch !== generation.current) return;
        registry!.noteSnapshot(open.snapshot);
        doc = docFromOpen(open);
        setDocs((previous) => ({ ...previous, [doc!.documentId]: doc! }));
        setTabs((previous) => previous.includes(doc!.documentId) ? previous : [...previous, doc!.documentId]);
      }
      renameRequest.current = { kind: "document", request: { ...(doc.location ? { location: doc.location } : {}), documentId: doc.documentId, baseRevision: doc.revision }, generation: epoch, source: target.path, target };
      setRenamePath(doc.path ?? target.path); setRenameDoc(doc.documentId);
    } catch (cause) { if (epoch === generation.current) setNotice(localizedFailure(cause, workspaceErrorText)); }
    finally { busyRef.current = false; setBusy(false); }
  }, [canOperate, isTargetCurrent, registry, workspaceGateway, docsRef, setDocs, setTabs, notify]);

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
      if (busyRef.current) return;
      if (!registry) {
        setNotice(message("ブラウザ表示では編集できません。デスクトップで開いてください。"));
        return;
      }
      const trimmed = path.trim();
      if (trimmed === "") {
        setNotice(message("フォルダーの絶対パスを入力してください。"));
        return;
      }
      search.suspend();
      const epoch = ++generation.current;
      busyRef.current = true; setBusy(true); setRefreshing(false);
      setNewFileOpen(false); setRenameDoc(null); setCreatedTarget(null);
      try {
        const info = await workspaceGateway!.openWorkspace(trimmed);
        if (epoch !== generation.current) return;
        rootRef.current = info.root;
        setWsRoot(info.root);
        onWorkspaceOpened?.();
        await loadEntries();
        const open = await workspaceGateway!.listDocuments();
        if (epoch !== generation.current) return;
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
      } finally {
        busyRef.current = false; setBusy(false);
        search.resume();
      }
    },
    [registry, workspaceGateway, loadEntries, refreshRecovery, setDocs, setTabs, setActiveId, setExternalByDoc, onWorkspaceOpened, notify],
  );

  /** Pick a folder natively and open it, staying read-only in browser. */
  const pickFolderAndOpen = useCallback(async () => {
    if (!canOperate()) return;
    if (!registry) {
      setNotice(message("ブラウザ表示では編集できません。デスクトップで開いてください。"));
      return;
    }
    const picked = await dialogGateway!.pickFolder(t("フォルダーを開く"));
    if (picked) await openWorkspaceFolder(picked);
  }, [registry, dialogGateway, openWorkspaceFolder, notify, canOperate]);

  /** Create a Markdown file from the dialog path and open it. */
  const createFile = useCallback(async () => {
    const target = creationTarget.current;
    if (!canOperate() || !target || !isTargetCurrent(target)) return;
    if (!registry) {
      setNotice(message("ブラウザ表示では編集できません。デスクトップで開いてください。"));
      return;
    }
    const path = newFilePath.trim();
    if (path === "") {
      setNotice(message(entryKind === "folder" ? "フォルダーの相対パスを入力してください。" : "ワークスペース相対のパス（例: メモ/新規.md）を入力してください。"));
      return;
    }
    const epoch = generation.current;
    busyRef.current = true; setBusy(true);
    try {
      if (entryKind === "folder") {
        await workspaceGateway!.createFolder(path);
        if (epoch !== generation.current) return;
        setNewFileOpen(false);
        await loadEntries();
        setCreatedTarget(targetFor(path, true));
        return;
      }
      const open = await workspaceGateway!.createMarkdown(path, "");
      if (epoch !== generation.current) return;
      registry.noteSnapshot(open.snapshot);
      const doc = docFromOpen(open);
      setDocs((prev) => ({ ...prev, [doc.documentId]: doc }));
      setTabs((prev) => (prev.includes(doc.documentId) ? prev : [...prev, doc.documentId]));
      setActiveId(doc.documentId);
      setNewFileOpen(false);
      await loadEntries();
      setCreatedTarget(targetFor(path, false, "markdown"));
    } catch (cause) {
      setNotice(localizedFailure(cause, workspaceErrorText));
    } finally { busyRef.current = false; setBusy(false); }
  }, [registry, workspaceGateway, newFilePath, loadEntries, setDocs, setTabs, setActiveId, notify, canOperate, isTargetCurrent, entryKind, targetFor]);

  /** Rename the dialog target keeping document IDs and updating tabs. */
  const renameFile = useCallback(async () => {
    const expected = renameRequest.current;
    if (!canOperate() || !expected || expected.generation !== generation.current || !renameDoc) return;
    if (!isTargetCurrent(expected.target)) return;
    const path = renamePath.trim();
    if (path === "") {
      setNotice(message("新しいパスを入力してください。"));
      return;
    }
    busyRef.current = true; setBusy(true);
    try {
      if (expected.kind === "folder") {
        const entry = await workspaceGateway!.renameFolder(expected.source, path);
        if (!isTargetCurrent(expected.target)) return;
        const oldPrefix = `${expected.source}/`;
        const newPrefix = `${entry.path}/`;
        setImageTabs((prev) => {
          const next: Record<string, string> = {};
          for (const [id, imagePath] of Object.entries(prev)) {
            if (imagePath === expected.source || imagePath.startsWith(oldPrefix)) {
              const mapped = imagePath === expected.source ? entry.path : `${newPrefix}${imagePath.slice(oldPrefix.length)}`;
              next[`image:${mapped}`] = mapped;
            } else {
              next[id] = imagePath;
            }
          }
          return next;
        });
        setTabs((prev) => prev.map((id) => {
          if (!id.startsWith("image:")) return id;
          const imagePath = id.slice("image:".length);
          if (imagePath === expected.source || imagePath.startsWith(oldPrefix)) {
            const mapped = imagePath === expected.source ? entry.path : `${newPrefix}${imagePath.slice(oldPrefix.length)}`;
            return `image:${mapped}`;
          }
          return id;
        }));
        setActiveId((prev) => {
          if (!prev?.startsWith("image:")) return prev;
          const imagePath = prev.slice("image:".length);
          if (imagePath === expected.source || imagePath.startsWith(oldPrefix)) {
            const mapped = imagePath === expected.source ? entry.path : `${newPrefix}${imagePath.slice(oldPrefix.length)}`;
            return `image:${mapped}`;
          }
          return prev;
        });
        setRenameDoc(null);
        await loadEntries();
        setNotice(message("名前を変更しました。"));
        setCreatedTarget(targetFor(entry.path, true));
        return;
      }
      if (expected.kind === "image") {
        const entry = await workspaceGateway!.renameImage(expected.source, path, expected.fingerprint);
        if (!isTargetCurrent(expected.target)) return;
        const oldId = `image:${expected.source}`;
        const nextId = `image:${entry.path}`;
        setImageTabs((prev) => {
          if (!(oldId in prev)) return prev;
          const next = { ...prev };
          delete next[oldId];
          next[nextId] = entry.path;
          return next;
        });
        setTabs((prev) => prev.map((id) => (id === oldId ? nextId : id)));
        setActiveId((prev) => (prev === oldId ? nextId : prev));
        setRenameDoc(null);
        await loadEntries();
        setNotice(message("名前を変更しました。"));
        setCreatedTarget(targetFor(entry.path, false, "image"));
        return;
      }
      if (!registry || expected.kind !== "document") return;
      const current = docsRef.current[expected.request.documentId];
      if (!current || expected.request.documentId !== renameDoc) return;
      const open = await registry.rename({ ...(expected.request.location ? { location: expected.request.location } : {}), documentId: expected.request.documentId, baseRevision: expected.request.baseRevision }, path);
      registry.noteSnapshot(open.snapshot);
      const doc = docFromOpen(open);
      setDocs((prev) => ({ ...prev, [doc.documentId]: doc }));
      setRenameDoc(null);
      await loadEntries();
      setNotice(message("名前を変更しました。"));
      setCreatedTarget(targetFor(path, false, doc.path !== null && /\.(md|markdown)$/i.test(doc.path) ? "markdown" : "text"));
    } catch (cause) {
      setNotice(localizedFailure(cause, workspaceErrorText));
    } finally { busyRef.current = false; setBusy(false); }
  }, [registry, workspaceGateway, renameDoc, renamePath, loadEntries, docsRef, setDocs, setTabs, setActiveId, setImageTabs, notify, canOperate, isTargetCurrent, targetFor]);

  /** Restore or discard a crash-recovery entry by ID. */
  const restoreEntry = useCallback(
    async (documentId: string, discard: boolean) => {
      if (!registry) return;
      try {
        if (discard) {
          await workspaceGateway!.discardRecovery(documentId);
        } else {
          const open = await workspaceGateway!.restoreRecovery(documentId);
          registry.noteSnapshot(open.snapshot);
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
      const result = await registry.configure({ ...(current.location ? { location: current.location } : {}), documentId: id, baseRevision: current.revision }, trimmed === "" ? null : trimmed);
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
    busy, generation: generation.current, refreshing, entryKind, createdTarget, targetFor, isTargetCurrent, canOperate, beginCreate, beginRename, refreshEntries,
    wsRoot,
    setWsRoot,
    entries: entries as WorkspaceEntry[],
    setEntries,
    recovery,
    searchQuery: search.searchQuery,
    setSearchQuery: search.setSearchQuery,
    searchOptions: search.searchOptions,
    setSearchOptions: search.setSearchOptions,
    searchError: search.searchError,
    searchLimit: search.searchLimit,
    resultsReady: search.resultsReady,
    replacing: search.replacing,
    registryHits: search.registryHits,
    searching: search.searching,
    replaceText: search.replaceText,
    setReplaceText: search.setReplaceText,
    localHits: search.localHits,
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
    jumpToHit: search.jumpToHit,
    replaceOne: search.replaceOne,
    replaceAllMatches: search.replaceAllMatches,
    refreshRuntime,
    handleRawGridKeys,
    handleRawGridRefresh,
    applyConfig,
  };
}

/** Return type of the workspace hook for shell composition. */
export type WorkspaceHandle = ReturnType<typeof useWorkspace>;

