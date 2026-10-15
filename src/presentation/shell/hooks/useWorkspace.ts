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
import type { SaveRequest, RecoveryEntry, RuntimeStatus, SearchOptions, SearchLimit, WorkspaceEntry, WorkspaceEvent, WorkspaceInfo, RootScope, CloseAction } from "../../../contracts/contracts";
import { sameRoot } from "../../../domain/document-location";
import { imageTabId, parseImageTabId } from "../../../domain/workspace-roots";
import { isMarkdownPath } from "../../../domain/workspace-files";
import type { PersistedTab, WorkspaceMetadata } from "../../../contracts/workspace-metadata";
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
  WorkspaceMetadataStore,
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
  /** Layout persistence, separate from native unsaved recovery. */
  metadataStore?: WorkspaceMetadataStore;
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
  roots: WorkspaceInfo[];
  entriesByRoot: Record<string, WorkspaceEntry[]>;
  missingRoots: string[];
  removingRoot: WorkspaceInfo | null;
  /** Add an independent folder while retaining existing buffers and tabs. */
  addWorkspaceFolder: (path: string) => Promise<void>;
  /** Pick an independent folder to add. */
  pickFolderAndAdd: () => Promise<void>;
  /** Ask for a root-wide removal decision. */
  beginRemoveRoot: (scope: RootScope) => void;
  /** Resolve root removal without dropping tabs on cancellation or save failure. */
  resolveRemoveRoot: (action: CloseAction) => Promise<void>;
  busy: boolean;
  generation: number;
  refreshing: boolean;
  entryKind: "file" | "folder";
  createdTarget: ExplorerTarget | null;
  /** Capture a relative tree location in the current root generation. */
  targetFor: (path?: string, directory?: boolean, kind?: WorkspaceEntry["kind"], scope?: RootScope) => ExplorerTarget;
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
  const { desktop, metadataStore, notify, session, workspaceGateway, eventSource, runtimeGateway, dialogGateway, showRaw, settingsOpen, routeVimKeys, onWorkspaceOpened } = args;
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
  const [roots, setRoots] = useState<WorkspaceInfo[]>([]);
  const rootsRef = useRef<WorkspaceInfo[]>([]);
  const [entriesByRoot, setEntriesByRoot] = useState<Record<string, WorkspaceEntry[]>>({});
  const [missingRoots, setMissingRoots] = useState<string[]>([]);
  const [removingRoot, setRemovingRoot] = useState<WorkspaceInfo | null>(null);
  const layoutStarted = useRef(false);
  const layoutLoading = useRef(desktop && !!metadataStore);
  const [layoutReady, setLayoutReady] = useState(false);
  const retainedLayout = useRef<WorkspaceMetadata | null>(null);
  const unavailableTabs = useRef<PersistedTab[]>([]);
  const search = useWorkspaceSearch({ desktop, root: wsRoot, roots, gateway: workspaceGateway, session, notify });
  /** Publish native owners before asynchronous opens can settle. */
  const updateRoots = useCallback((next: WorkspaceInfo[]) => { rootsRef.current = next; session.configureRoots(next); setRoots(next); }, [session.configureRoots]);
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

  /** List every root separately, rejecting listings from a changed lifecycle. */
  const loadEntries = useCallback(async (): Promise<WorkspaceEntry[]> => {
    const epoch = generation.current;
    const ticket = ++listing.current;
    const next: Record<string, WorkspaceEntry[]> = {};
    for (const owner of rootsRef.current) {
      const initial = await workspaceGateway!.listWorkspace("", owner.scope);
      if (epoch !== generation.current) return [];
      const all = [...initial];
      const queue = initial.filter((entry) => entry.directory).map((entry) => entry.path);
      const seen = new Set(queue);
      while (queue.length && all.length < 2000) {
        const dir = queue.shift()!;
        try {
          const children = await workspaceGateway!.listWorkspace(dir, owner.scope);
          if (epoch !== generation.current) return [];
          all.push(...children.slice(0, 2000 - all.length));
          for (const child of children) if (child.directory && !seen.has(child.path)) { seen.add(child.path); queue.push(child.path); }
        } catch { /* Keep unreadable directory rows available. */ }
      }
      next[owner.scope.rootId] = all;
    }
    const first = next[rootsRef.current[0]?.scope.rootId] ?? [];
    if (epoch === generation.current && ticket === listing.current) { setEntriesByRoot(next); setEntries(first); }
    return first;
  }, [workspaceGateway]);

  /** Capture an explicit root and relative path before focus changes. */
  const targetFor = useCallback((path = "", directory = true, kind?: WorkspaceEntry["kind"], scope?: RootScope): ExplorerTarget => ({ rootId: (scope ?? rootsRef.current[0]?.scope)?.rootId ?? "", generation: generation.current, path, directory, kind }), []);
  /** Reject removed or replaced tree sessions, including pending dialogs. */
  const isTargetCurrent = useCallback((target: ExplorerTarget) => target.generation === generation.current && rootsRef.current.some((root) => root.scope.rootId === target.rootId), []);
  /** Resolve the native incarnation captured by an explorer target. */
  const scopeFor = useCallback((target: ExplorerTarget) => rootsRef.current.find((root) => root.scope.rootId === target.rootId)?.scope, []);
  /** Recheck native lifecycle availability synchronously before every invocation. */
  const canOperate = useCallback(() => desktop && !!registry && !!workspaceGateway && !busyRef.current && !layoutLoading.current, [desktop, registry, workspaceGateway]);
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
      const ownerScope = scopeFor(target);
      const blocked = Object.values(docsRef.current).some((doc) => doc.path !== null && (doc.path === target.path || doc.path.startsWith(prefix)) && (!doc.location || sameRoot(doc.location.scope, ownerScope)));
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
        const data = await workspaceGateway!.loadWorkspaceImage(target.path, scopeFor(target));
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
      let doc = Object.values(docsRef.current).find((item) => item.path === target.path && ((!item.location && rootsRef.current.length === 1) || sameRoot(item.location?.scope, scopeFor(target))));
      if (!doc) {
        const open = target.kind === "text"
          ? await workspaceGateway!.openTextFile(target.path, scopeFor(target))
          : await workspaceGateway!.openMarkdown(target.path, scopeFor(target));
        if (epoch !== generation.current || !isTargetCurrent(target)) return;
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
      const groups = await Promise.all(rootsRef.current.map((root) => workspaceGateway!.listRecovery(root.scope)));
      setRecovery(groups.flat());
    } catch (cause) {
      setNotice(localizedFailure(cause, workspaceErrorText));
    }
  }, [registry, workspaceGateway, notify]);

  /** Open a workspace root and load entries, docs, and recovery. */
  const registerFolder = useCallback(
    async (path: string, additive = false): Promise<WorkspaceInfo | null> => {
      if (busyRef.current) return null;
      if (!registry) {
        setNotice(message("ブラウザ表示では編集できません。デスクトップで開いてください。"));
        return null;
      }
      const trimmed = path.trim();
      if (trimmed === "") {
        setNotice(message("フォルダーの絶対パスを入力してください。"));
        return null;
      }
      search.suspend();
      const epoch = ++generation.current;
      busyRef.current = true; setBusy(true); setRefreshing(false);
      setNewFileOpen(false); setRenameDoc(null); setCreatedTarget(null);
      let registered: WorkspaceInfo | null = null;
      try {
        const info = await (additive ? workspaceGateway!.addWorkspace!(trimmed) : workspaceGateway!.openWorkspace(trimmed));
        if (epoch !== generation.current) return null;
        registered = info;
        setMissingRoots((previous) => previous.filter((root) => root !== trimmed && root !== info.root));
        updateRoots(additive ? [...rootsRef.current, info] : [info]);
        rootRef.current = rootsRef.current[0].root;
        setWsRoot(rootRef.current);
        onWorkspaceOpened?.();
        await loadEntries();
        const open = await workspaceGateway!.listDocuments(info.scope);
        if (epoch !== generation.current) return null;
        const next: Record<string, OpenDoc> = {};
        for (const doc of open) {
          if (registry) registry.noteSnapshot(doc.snapshot);
          next[doc.snapshot.documentId] = docFromOpen(doc);
        }
        setDocs((previous) => additive ? { ...previous, ...next } : next);
        if (!additive) {
          session.setImageTabs({});
          setTabs(open.map((doc) => doc.snapshot.documentId));
          setActiveId(open.map((doc) => doc.snapshot.documentId)[0] ?? null);
          setExternalByDoc({});
        }
        await refreshRecovery();
        setNotice(null);
        return info;
      } catch (cause) {
        setNotice(localizedFailure(cause, workspaceErrorText));
        return registered;
      } finally {
        busyRef.current = false; setBusy(false);
        search.resume();
      }
    },
    [registry, workspaceGateway, loadEntries, refreshRecovery, setDocs, setTabs, setActiveId, setExternalByDoc, onWorkspaceOpened, notify, updateRoots, session.setImageTabs],
  );

  /** Replace the workspace through the native unsaved-buffer guard. */
  const openWorkspaceFolder = useCallback(async (path: string) => { await registerFolder(path); }, [registerFolder]);
  /** Add a root without replacing documents, images, tabs, or selections. */
  const addWorkspaceFolder = useCallback(async (path: string) => { if (workspaceGateway?.addWorkspace) await registerFolder(path, true); }, [registerFolder, workspaceGateway]);
  /** Pick an independent folder without altering the active tab. */
  const pickFolderAndAdd = useCallback(async () => {
    if (!canOperate() || !workspaceGateway?.addWorkspace) return;
    const path = await dialogGateway?.pickFolder(t("ワークスペースにフォルダーを追加"));
    if (path) await addWorkspaceFolder(path);
  }, [canOperate, workspaceGateway, dialogGateway, t, addWorkspaceFolder]);
  /** Offer a root-wide decision while leaving every native buffer alive. */
  const beginRemoveRoot = useCallback((scope: RootScope) => {
    if (canOperate() && workspaceGateway?.removeWorkspace) setRemovingRoot(rootsRef.current.find((root) => sameRoot(root.scope, scope)) ?? null);
  }, [canOperate, workspaceGateway]);
  /** Commit removal on native acknowledgement; failures retain roots and every tab. */
  const resolveRemoveRoot = useCallback(async (action: CloseAction) => {
    const owner = removingRoot;
    if (action === "cancel") { setRemovingRoot(null); return; }
    if (!owner || !canOperate() || !workspaceGateway?.removeWorkspace) return;
    busyRef.current = true; setBusy(true); search.suspend(); ++generation.current;
    try {
      const removed = await workspaceGateway.removeWorkspace(owner.scope, action);
      if (!removed) return;
      const removedIds = new Set(Object.values(docsRef.current).filter((doc) => sameRoot(doc.location?.scope, owner.scope)).map((doc) => doc.documentId));
      for (const id of session.tabs) if (sameRoot(session.imageScope(id), owner.scope)) removedIds.add(id);
      updateRoots(rootsRef.current.filter((root) => !sameRoot(root.scope, owner.scope)));
      rootRef.current = rootsRef.current[0]?.root ?? null; setWsRoot(rootRef.current);
      setDocs((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => !removedIds.has(id))));
      session.setImageTabs((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => !removedIds.has(id))));
      setTabs((previous) => { const next = previous.filter((id) => !removedIds.has(id)); if (activeRef.current && removedIds.has(activeRef.current)) setActiveId(next.at(-1) ?? null); return next; });
      setRemovingRoot(null); onWorkspaceOpened?.();
      await loadEntries(); await refreshRecovery();
    } catch (cause) {
      setNotice(localizedFailure(cause, workspaceErrorText));
      // Earlier saves may have succeeded; refresh acknowledgements without closing tabs.
      for (const root of rootsRef.current) for (const open of await workspaceGateway.listDocuments(root.scope).catch(() => [])) mergeSnapshot(open.snapshot);
    } finally { busyRef.current = false; setBusy(false); search.resume(); }
  }, [removingRoot, canOperate, workspaceGateway, session.tabs, session.imageScope, session.setImageTabs, updateRoots, setWsRoot, setDocs, setTabs, setActiveId, activeRef, docsRef, loadEntries, refreshRecovery, mergeSnapshot, notify, onWorkspaceOpened]);

  // Restore metadata only after Rust reissues each root incarnation. Text recovery
  // remains separate and is never discarded merely to reopen a previous tab.
  useEffect(() => {
    if (layoutStarted.current || !desktop || !metadataStore || !registry || !workspaceGateway) return;
    layoutStarted.current = true;
    const metadata = metadataStore.load();
    retainedLayout.current = metadata;
    /** Restore reachable owners, retaining unavailable roots and tabs verbatim. */
    async function restoreLayout() {
      const existing = await workspaceGateway!.listWorkspaces?.().catch(() => []) ?? [];
      const nativeDocs: Record<string, OpenDoc> = {};
      if (existing.length) {
        updateRoots(existing); rootRef.current = existing[0].root; setWsRoot(existing[0].root);
        for (const root of existing) for (const open of await workspaceGateway!.listDocuments(root.scope)) {
          registry!.noteSnapshot(open.snapshot);
          nativeDocs[open.snapshot.documentId] = docFromOpen(open);
        }
        await loadEntries(); await refreshRecovery();
      }
      if (!metadata) {
        setDocs((previous) => ({ ...previous, ...nativeDocs }));
        setTabs(Object.keys(nativeDocs)); setActiveId(Object.keys(nativeDocs)[0] ?? null);
        layoutLoading.current = false; setLayoutReady(true); return;
      }
      const missing: string[] = [];
      for (const owner of metadata.roots) {
        if (rootsRef.current.some((root) => root.root === owner.root)) continue;
        const info = await registerFolder(owner.root, rootsRef.current.length > 0);
        if (!info) missing.push(owner.root);
      }
      const restoredDocs: Record<string, OpenDoc> = { ...nativeDocs };
      const restoredImages: Record<string, string> = {};
      const restoredTabs: string[] = [];
      let restoredActive: string | null = null;
      unavailableTabs.current = [];
      for (const tab of metadata.tabs) {
        const owner = rootsRef.current.find((root) => root.root === tab.root);
        if (!owner) { unavailableTabs.current.push(tab); continue; }
        try {
          let id: string;
          if (tab.image) {
            // Validate the image through its owner; never borrow another root's bytes.
            await workspaceGateway!.loadWorkspaceImage(tab.path, owner.scope);
            id = imageTabId(owner.scope.rootId, tab.path);
            restoredImages[id] = tab.path;
          } else {
            const open = await (isMarkdownPath(tab.path) ? workspaceGateway!.openMarkdown(tab.path, owner.scope) : workspaceGateway!.openTextFile(tab.path, owner.scope));
            registry!.noteSnapshot(open.snapshot);
            const doc = docFromOpen(open); id = doc.documentId; restoredDocs[id] = doc;
            if (tab.selection) {
              const anchor = Math.min(tab.selection.anchor, doc.text.length);
              const head = Math.min(tab.selection.head, doc.text.length);
              await registry!.reportCursorNow(id, anchor, head);
              session.setSelections((previous) => ({ ...previous, [id]: { anchor, head } }));
              session.echoCursor(id, anchor, head);
            }
          }
          if (!restoredTabs.includes(id)) restoredTabs.push(id);
          if (metadata.active?.root === tab.root && metadata.active.path === tab.path && metadata.active.image === tab.image) restoredActive = id;
        } catch { unavailableTabs.current.push(tab); }
      }
      for (const id of Object.keys(nativeDocs)) if (!restoredTabs.includes(id)) restoredTabs.push(id);
      setDocs((previous) => ({ ...previous, ...restoredDocs }));
      session.setImageTabs(restoredImages); setTabs(restoredTabs); setActiveId(restoredActive ?? restoredTabs[0] ?? null);
      setMissingRoots(missing);
      layoutLoading.current = false; setLayoutReady(true);
    }
    void restoreLayout().catch((cause) => { layoutLoading.current = false; setLayoutReady(true); setNotice(localizedFailure(cause, workspaceErrorText)); });
  }, [desktop, metadataStore, registry, workspaceGateway, registerFolder, setDocs, setTabs, setActiveId, session.setImageTabs, session.setSelections, session.echoCursor, notify]);

  useEffect(() => {
    if (!desktop || !metadataStore || !layoutReady || busy || !retainedLayout.current) return;
    const tabs: PersistedTab[] = [...unavailableTabs.current];
    let activeTab: PersistedTab | null = null;
    for (const id of session.tabs) {
      const doc = session.docs[id];
      const scope = session.imageScope(id) ?? doc?.location?.scope;
      const owner = roots.find((root) => sameRoot(root.scope, scope));
      const path = session.imageTabs[id] ?? doc?.path;
      if (!owner || !path) continue;
      const tab: PersistedTab = { root: owner.root, path, image: !!session.imageTabs[id], ...(session.selections[id] ? { selection: session.selections[id] } : {}) };
      tabs.push(tab);
      if (id === session.activeId) activeTab = tab;
    }
    const metadata: WorkspaceMetadata = { version: 1, roots: [...roots.map(({ root }) => ({ root })), ...missingRoots.map((root) => ({ root }))], tabs, active: activeTab ?? (session.activeId === null ? retainedLayout.current.active : null) };
    metadataStore.save(metadata);
  }, [desktop, metadataStore, layoutReady, busy, roots, missingRoots, session.tabs, session.docs, session.imageTabs, session.selections, session.activeId, session.imageScope]);

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
        await workspaceGateway!.createFolder(path, scopeFor(target));
        if (epoch !== generation.current) return;
        setNewFileOpen(false);
        await loadEntries();
        setCreatedTarget(targetFor(path, true, undefined, scopeFor(target)));
        return;
      }
      const open = await workspaceGateway!.createMarkdown(path, "", scopeFor(target));
      if (epoch !== generation.current) return;
      registry.noteSnapshot(open.snapshot);
      const doc = docFromOpen(open);
      setDocs((prev) => ({ ...prev, [doc.documentId]: doc }));
      setTabs((prev) => (prev.includes(doc.documentId) ? prev : [...prev, doc.documentId]));
      setActiveId(doc.documentId);
      setNewFileOpen(false);
      await loadEntries();
      setCreatedTarget(targetFor(path, false, "markdown", scopeFor(target)));
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
        const ownerScope = rootsRef.current.find((root) => root.scope.rootId === expected.target.rootId)?.scope;
        const entry = await workspaceGateway!.renameFolder(expected.source, path, ownerScope);
        if (!isTargetCurrent(expected.target)) return;
        const oldPrefix = `${expected.source}/`;
        const newPrefix = `${entry.path}/`;
        const ownerId = expected.target.rootId;
        const single = rootsRef.current.length === 1;
        setImageTabs((prev) => {
          const next: Record<string, string> = {};
          for (const [id, imagePath] of Object.entries(prev)) {
            const parsed = parseImageTabId(id);
            const tabRoot = parsed?.rootId ?? null;
            const tabPath = parsed ? parsed.path : imagePath;
            const owned = tabRoot !== null ? tabRoot === ownerId : single;
            if (owned && (tabPath === expected.source || tabPath.startsWith(oldPrefix))) {
              const mapped = tabPath === expected.source ? entry.path : `${newPrefix}${tabPath.slice(oldPrefix.length)}`;
              const nextId = tabRoot !== null && ownerScope ? imageTabId(ownerScope.rootId, mapped) : `image:${mapped}`;
              next[nextId] = mapped;
            } else {
              next[id] = imagePath;
            }
          }
          return next;
        });
        setTabs((prev) => prev.map((id) => {
          const parsed = parseImageTabId(id);
          if (!parsed) return id;
          const tabRoot = parsed.rootId;
          const owned = tabRoot !== null ? tabRoot === ownerId : single;
          if (!owned) return id;
          if (parsed.path === expected.source || parsed.path.startsWith(oldPrefix)) {
            const mapped = parsed.path === expected.source ? entry.path : `${newPrefix}${parsed.path.slice(oldPrefix.length)}`;
            if (tabRoot !== null && ownerScope) return imageTabId(ownerScope.rootId, mapped);
            return `image:${mapped}`;
          }
          return id;
        }));
        setActiveId((prev) => {
          const parsed = prev ? parseImageTabId(prev) : null;
          if (!parsed || !prev) return prev;
          const tabRoot = parsed.rootId;
          const owned = tabRoot !== null ? tabRoot === ownerId : single;
          if (!owned) return prev;
          if (parsed.path === expected.source || parsed.path.startsWith(oldPrefix)) {
            const mapped = parsed.path === expected.source ? entry.path : `${newPrefix}${parsed.path.slice(oldPrefix.length)}`;
            if (tabRoot !== null && ownerScope) return imageTabId(ownerScope.rootId, mapped);
            return `image:${mapped}`;
          }
          return prev;
        });
        setRenameDoc(null);
        await loadEntries();
        setNotice(message("名前を変更しました。"));
        setCreatedTarget(targetFor(entry.path, true, undefined, ownerScope));
        return;
      }
      if (expected.kind === "image") {
        const ownerScope = rootsRef.current.find((root) => root.scope.rootId === expected.target.rootId)?.scope;
        const entry = await workspaceGateway!.renameImage(expected.source, path, expected.fingerprint, ownerScope);
        if (!isTargetCurrent(expected.target)) return;
        const single = rootsRef.current.length === 1;
        const qualifiedOld = ownerScope ? imageTabId(ownerScope.rootId, expected.source) : null;
        const qualifiedNext = ownerScope ? imageTabId(ownerScope.rootId, entry.path) : null;
        const legacyOld = `image:${expected.source}`;
        const legacyNext = `image:${entry.path}`;
        setImageTabs((prev) => {
          if (qualifiedOld && qualifiedOld in prev && qualifiedNext) {
            const next = { ...prev };
            delete next[qualifiedOld];
            next[qualifiedNext] = entry.path;
            return next;
          }
          if (single && legacyOld in prev) {
            const next = { ...prev };
            delete next[legacyOld];
            next[legacyNext] = entry.path;
            return next;
          }
          return prev;
        });
        setTabs((prev) => prev.map((id) => {
          if (qualifiedOld && id === qualifiedOld && qualifiedNext) return qualifiedNext;
          if (single && id === legacyOld) return legacyNext;
          return id;
        }));
        setActiveId((prev) => {
          if (qualifiedOld && prev === qualifiedOld && qualifiedNext) return qualifiedNext;
          if (single && prev === legacyOld) return legacyNext;
          return prev;
        });
        setRenameDoc(null);
        await loadEntries();
        setNotice(message("名前を変更しました。"));
        setCreatedTarget(targetFor(entry.path, false, "image", ownerScope));
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
      setCreatedTarget(targetFor(path, false, doc.path !== null && /\.(md|markdown)$/i.test(doc.path ?? "") ? "markdown" : "text", doc.location?.scope));
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
      Promise.all(rootsRef.current.map((root) => workspaceGateway!.pollEvents(root.scope))).then((events) => handleEvents(events.flat())).catch(() => undefined);
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
    roots, entriesByRoot, missingRoots, removingRoot, addWorkspaceFolder, pickFolderAndAdd, beginRemoveRoot, resolveRemoveRoot,
    busy: busy || layoutLoading.current, generation: generation.current, refreshing, entryKind, createdTarget, targetFor, isTargetCurrent, canOperate, beginCreate, beginRename, refreshEntries,
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

