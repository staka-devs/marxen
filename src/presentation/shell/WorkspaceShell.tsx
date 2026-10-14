import { localizedFailure } from "../../domain/localization";
import type { LocalizedText } from "../../contracts/localization";
import type { LabelKey } from "../../contracts/localization";
import { useI18n } from "../i18n/I18nProvider";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { MessageSquare, Files, ListTree, Save, Search, Settings as SettingsIcon, Ellipsis, PanelsLeftRight, Info, ChevronRight, FileText, FilePlus2, FolderPlus, RefreshCw } from "lucide-react";
import { CodeMirrorEditor } from "../editor/CodeMirrorEditor";
import { MarkdownPreview } from "../preview/MarkdownPreview";
import AiPanel from "../ai-panel";
import { AiUsagePopover } from "../ai/AiUsagePopover";
import type { AiUsageGateway, CodexAccountUsageGateway } from "../../application/ai/usage-ports";
import { AiModelControls } from "../ai-model-controls";
import { useAiModels } from "./hooks/useAiModels";
import { useAiViewPreferences } from "../ai/useAiViewPreferences";
import { AiVisibilityDialog, AiVisibilitySettings } from "../ai/AiVisibilitySettings";
import { ResizableAiPane } from "../ai/ResizableAiPane";
import type { AiViewPreferencesStore } from "../../application/ai/view-preferences-port";
import AiProviderSettings from "../ai-provider-settings";
import { EditorActionsPopover } from "../workspace/EditorActionsPopover";
import { WorkspaceSidebar } from "../workspace/WorkspaceSidebar";
import InlineChat from "../ai-inline-chat";
import ReviewPanel from "../review-panel";
import type { AiProviderConfig } from "../../contracts/ai-contracts";
import { buildProviderConfig } from "../../domain/ai-config";
import { FileTree, buildTree } from "../workspace/FileTree";
import { ImageViewer } from "../workspace/ImageViewer";
import { ImageDropZone } from "../workspace/ImageDropZone";
import { Tabs, type TabItem } from "../workspace/Tabs";
import { QuickOpen } from "../workspace/QuickOpen";
import { SearchPanel } from "../workspace/SearchPanel";
import { Outline } from "../workspace/Outline";
import { CommandPalette } from "../workspace/CommandPalette";
import { SettingsPanel } from "../workspace/SettingsPanel";
import { VimSettingsHost } from "../vim-settings/VimSettingsHost";
import type { VimSettingsGateway } from "../../application/vim-settings/ports";
import { RawGridView } from "../workspace/RawGridView";
import { GuiToolbar } from "../workspace/GuiToolbar";
import { EditorMenu } from "../editor/EditorMenu";
import { useEditorMenu } from "./hooks/useEditorMenu";
import { useWorkbenchCommands } from "./hooks/useWorkbenchCommands";
import { WorkbenchMenuBar } from "../workspace/WorkbenchMenuBar";
import type { ExplorerTarget } from "../../contracts/workbench";
import type { TreeNode } from "../workspace/FileTree";
import { NotificationToast, WorkspaceDialog, type Notice, type NoticeKind } from "../workspace/Notifications";
import {
  formatRange,
  insertImage,
  insertLink,
  insertTable,
  tableActionEdits,
  tableCellAt,
  toggleCheckbox,
  type FormatKind,
} from "../../domain/markdown-gui";
import type { ThemeId } from "../../domain/workspace-content";
import {
  workspaceErrorText,
} from "../../domain/document-errors";
import { COPY_LABELS } from "../../domain/clipboard-text";
import { offsetToLineCol } from "../../domain/coordinates/utf16";
import { DEFAULT_EDITOR_PREFERENCES, normalizeEditorPreferences, type EditorPreferences } from "../../domain/editor-preferences";
import { entryKind } from "../../domain/workspace-files";
import { docFromOpen, fileLabel } from "../../application/document/document-helpers";
import type {
  AiGateway,
  AiProfileStore,
  ClipboardGateway,
  DialogGateway,
  DocumentGateway,
  DropGateway,
  EditorPreferencesStore,
  ImageLoader,
  IsolationGateway,
  RuntimeGateway,
  WorkspaceEventSource,
  WorkspaceGateway,
} from "../../application/ports";
import type { ViewMode, NavBasis, SideView } from "./shellView";
import { useDocumentSession } from "./hooks/useDocumentSession";
import { useVimEditing } from "./hooks/useVimEditing";
import { useWorkspace } from "./hooks/useWorkspace";
import { useImageAttachments } from "./hooks/useImageAttachments";
import { useAiStaging } from "./hooks/useAiStaging";

export type { ViewMode, NavBasis, SideView } from "./shellView";

/**
 * Injected shell dependencies from the composition root.
 *
 * All native transports arrive via these narrow ports so the shell never
 * imports infrastructure directly; tests inject fakes for the same surface.
 */
export interface WorkspaceShellProps {
  languagePreference?: import("../../contracts/language").LanguagePreference;
  /** Select and persist the active presentation language without remounting the workspace. */
  onLanguagePreference?: (preference: import("../../contracts/language").LanguagePreference) => void;
  /** Serial revision-aware document gateway (registry or read-only). */
  documentGateway?: DocumentGateway;
  /** Workspace file and recovery gateway over native IPC. */
  workspaceGateway?: WorkspaceGateway;
  /** Pushed workspace event subscription with polling fallback. */
  eventSource?: WorkspaceEventSource;
  /** AI streaming, credentials, and connection tests. */
  aiGateway?: AiGateway;
  /** Read retained usage and observe metadata without starting an AI prompt. */
  aiUsageGateway?: AiUsageGateway;
  /** Read the authenticated Codex account's officially reported limits. */
  codexAccountUsageGateway?: CodexAccountUsageGateway;
  /** Isolation staging lifecycle pinned by Rust. */
  isolationGateway?: IsolationGateway;
  /** Runtime connectivity status. */
  runtimeGateway?: RuntimeGateway;
  /** Native folder and config pickers. */
  dialogGateway?: DialogGateway;
  /** Native file-drop subscription. */
  dropGateway?: DropGateway;
  /** Native clipboard writes through Rust. */
  clipboardGateway?: ClipboardGateway;
  /** Non-secret AI profile persistence. */
  aiProfileStore?: AiProfileStore;
  /** Persist AI control visibility and right-chat width independently of editor settings. */
  aiViewPreferencesStore?: AiViewPreferencesStore;
  /** View-only editor preferences persistence. */
  editorPreferencesStore?: EditorPreferencesStore;
  /** Document-scoped image byte loader. */
  imageLoader?: ImageLoader;
  /** Fingerprint-guarded Vim configuration editor supplied by composition. */
  vimSettingsGateway?: VimSettingsGateway;
  /** True on desktop; browser demo stays read-only. */
  desktop?: boolean;
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

/**
 * Workspace shell composing editors, sidebars, AI, and review via injected ports.
 *
 * Owns UI layout and React state; revision, staging, and transport operations
 * delegate to application services and injected gateways. Real Neovim stays
 * authoritative with stale resync, generation fencing, and scoped approval.
 */
export function WorkspaceShell(props: WorkspaceShellProps = {}) {
  const { t, message } = useI18n();
  const {
    documentGateway,
    workspaceGateway,
    eventSource,
    aiGateway,
    aiUsageGateway,
    codexAccountUsageGateway,
    isolationGateway,
    runtimeGateway,
    dialogGateway,
    dropGateway,
    clipboardGateway,
    aiProfileStore,
    editorPreferencesStore,
    imageLoader,
    vimSettingsGateway,
    desktop: desktopProp,
  } = props;
  const desktop = desktopProp ?? false;
  const [viewMode, setViewMode] = useState<ViewMode>("live");
  const [splitRatio, setSplitRatio] = useState(50);
  const [navBasis, setNavBasis] = useState<NavBasis>("source");
  const [showRaw, setShowRaw] = useState(false);
  const [sideView, setSideView] = useState<SideView | null>("explorer");
  const [showAi, setShowAi] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [manualFolder, setManualFolder] = useState(false);
  const [explorerTarget, setExplorerTarget] = useState<ExplorerTarget | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [aiProvider, setAiProvider] = useState<AiProviderConfig>(() => {
    try {
      const saved = aiProfileStore?.load();
      if (!saved) return buildProviderConfig({ kind: "acp", preset: "codex", command: "", argsText: "", endpoint: "https://api.openai.com/v1", model: "", anthropicEnabled: false });
      return buildProviderConfig(saved);
    } catch {
      return buildProviderConfig({ kind: "acp", preset: "codex", command: "", argsText: "", endpoint: "https://api.openai.com/v1", model: "", anthropicEnabled: false });
    }
  });

  const aiModels = useAiModels(aiProvider, aiGateway);
  const aiView = useAiViewPreferences(props.aiViewPreferencesStore);
  const [aiVisibilityOpen, setAiVisibilityOpen] = useState(false);
  /** Restore the composer after managing its view-only preferences. */
  const closeAiVisibility = useCallback(() => setAiVisibilityOpen(false), []);

  const [preferences, setPreferences] = useState(() => {
    try {
      return editorPreferencesStore?.load() ?? { ...DEFAULT_EDITOR_PREFERENCES };
    } catch {
      return { ...DEFAULT_EDITOR_PREFERENCES };
    }
  });
  const theme = preferences.theme;
  /**
   * Normalize and persist editor preferences, noticing once on failure.
   *
   * View-only settings apply immediately; document/AI state stays native-owned.
   */
  const updatePreferences = useCallback((next: EditorPreferences) => {
    const normalized = normalizeEditorPreferences(next);
    setPreferences(normalized);
    try {
      const ok = editorPreferencesStore?.save(normalized);
      if (ok === false) setNotice(message("設定を保存できませんでした。この起動中は変更を保持します。"));
    } catch {
      setNotice(message("設定を保存できませんでした。この起動中は変更を保持します。"));
    }
  }, [editorPreferencesStore]);
  /**
   * Apply a theme by persisting preferences with the new theme.
   *
   * Thin wrapper preserving the current font/wrap settings.
   */
  const setTheme = (next: ThemeId) => updatePreferences({ ...preferences, theme: next });
  const [quickOpen, setQuickOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [settings, setSettings] = useState(false);
  const [folderInput, setFolderInput] = useState("");
  const [notice, setNoticeState] = useState<Notice | null>(null);
  const noticeSequence = useRef(0);
  /** Emit a distinct notification occurrence without changing the editor's layout. */
  const setNotice = useCallback((message: LocalizedText | null, kind: NoticeKind = "info") => {
    setNoticeState(message === null ? null : { id: ++noticeSequence.current, message, kind });
  }, []);
  /** Dismiss only the notification whose timeout or close action is still current. */
  const dismissNotice = useCallback((id: number) => setNoticeState((current) => current?.id === id ? null : current), []);
  const [recoveryPromptOpen, setRecoveryPromptOpen] = useState(false);
  const [dismissedExternal, setDismissedExternal] = useState<{ path: string; deleted: boolean } | null>(null);
  /** Revision-aware document session: docs, tabs, selections, and mutations. */
  const session = useDocumentSession({ desktop, documentGateway, workspaceGateway, clipboardGateway, notify: setNotice });
  const editorMenu = useEditorMenu({ session, desktop, notify: setNotice });
  const [editorFocus, setEditorFocus] = useState<{ path: string; sequence: number } | null>(null);
  /** Open a file and request editor focus after React commits the active pane. */
  async function openFileForEditing(path: string) {
    await session.openFile(path);
    setEditorFocus((previous) => ({ path, sequence: (previous?.sequence ?? 0) + 1 }));
  }
  /** Vim key routing with optimistic ranges and mapping-first execution. */
  const vim = useVimEditing({ desktop, navBasis, hardBreakOnEnter: preferences.hardBreakOnEnter, notify: setNotice, session });
  /** Workspace lifecycle: entries, search, events, runtime, grid, config. */
  const workspace = useWorkspace({
    desktop,
    notify: setNotice,
    session,
    workspaceGateway,
    eventSource,
    runtimeGateway,
    dialogGateway,
    showRaw,
    settingsOpen: settings,
    routeVimKeys: vim.routeVimKeys,
    /** Reset folder UI after a workspace opens. */
    onWorkspaceOpened: () => { setManualFolder(false); setExplorerTarget(null); },
  });
  const recoveryKey = workspace.recovery.map((entry) => entry.documentId).join("\0");
  useEffect(() => { setRecoveryPromptOpen(recoveryKey.length > 0); }, [recoveryKey]);
  /** Image attachments: resolvers, paste capture, and drop routing. */
  const image = useImageAttachments({
    desktop,
    notify: setNotice,
    session,
    vim,
    workspaceGateway,
    imageLoader,
    loadEntries: workspace.loadEntries,
  });
  /** Refresh Explorer listings after AI imports register new documents. */
  const refreshAfterImport = useCallback(() => { void workspace.loadEntries(); }, [workspace]);
  /** AI review and inline flow with shared staging exclusion. */
  const staging = useAiStaging({
    desktop,
    notify: setNotice,
    session,
    isolationGateway,
    onWorkspaceChanged: refreshAfterImport,
  });
  const modelControls = <AiModelControls provider={aiProvider} onProvider={setAiProvider} {...aiModels} preferences={aiView.preferences} onManageVisibility={() => setAiVisibilityOpen(true)} onRefresh={() => void aiModels.refresh()} disabled={staging.agentBusy || staging.inlineBusy} />;
  // Read-through aliases for narrowing-heavy JSX; ownership stays in hooks.
  /** Active document for pane rendering. */
  const active = session.active;
  /** Active image path for `image:` tabs, if any. */
  const activeImage = session.activeImage;
  /** Whether the active document renders as Markdown. */
  const activeIsMarkdown = session.activeIsMarkdown;
  /** Active tab ID for tabs and footer display. */
  const activeId = session.activeId;
  /** GUI selections keyed by document ID. */
  const selections = session.selections;
  /** Shell cursor echoes keyed by document ID. */
  const cursorEcho = session.cursorEcho;
  /** Current Vim mode label for display. */
  const vimMode = session.vimMode;

  const effectiveViewMode: ViewMode = active && !activeIsMarkdown ? "source" : viewMode;

  // Snapshot merge, stale resync, cursor refresh, and selection follow-up
  // live in useDocumentSession with generation fencing.

  // Workspace entries, folder open, and file open live in useWorkspace and
  // useDocumentSession with injected gateway ports.

  // Document mutations (edits, Vim input, undo/redo, save, close) live in
  // useDocumentSession; selection sync follows in the same owner.

  // GUI selection staging and explicit jumps live in useDocumentSession.

  // -- GUI range actions -----------------------------------------------------

  // GUI range actions and Vim key routing live in useVimEditing with
  // optimistic caret and execution-time native-mode decisions.

  // Printable character routing lives in useVimEditing.

  // Captured paste routing lives in useVimEditing.

  // Editor key dispatch lives in useVimEditing with IME coexistence.

  // Paste capture and image drops live in useImageAttachments with
  // event-first clipboard handling and chained multi-file revisions.

  // Revision-aware search and replace live in useWorkspace with debounced
  // registry search, local demo search, and chained replace revisions.

  // Workspace events, runtime status, and raw grid screens live in
  // useWorkspace with subscription cleanup and incremental redraws.

  // Local-image resolvers live in useImageAttachments bound to the active
  // document; Neovim config application lives in useWorkspace.

  /** Shared guarded workbench command owner; state-only views stay in the shell. */
  const workbench = useWorkbenchCommands({ desktop, session, workspace, target: explorerTarget, notify: setNotice, openFile: openFileForEditing,
    uiActions: {
      /** Open the existing manual root-path dialog. */
      "folder-path": () => setManualFolder(true),
      /** Display live Markdown. */
      "view-live": () => setViewMode("live"),
      /** Display raw source. */
      "view-source": () => setViewMode("source"),
      /** Display the read-only preview. */
      "view-read": () => setViewMode("read"),
      /** Display the existing split panes. */
      "view-split": () => setViewMode("split"),
      /** Use display-row navigation. */
      "nav-display": () => setNavBasis("display"),
      /** Use native Vim navigation. */
      "nav-source": () => setNavBasis("source"),
      /** Toggle the explorer sidebar. */
      "view-explorer": () => setSideView(value => value === "explorer" ? null : "explorer"),
      /** Toggle the search sidebar. */
      "view-search": () => setSideView(value => value === "search" ? null : "search"),
      /** Toggle the outline sidebar. */
      "view-outline": () => setSideView(value => value === "outline" ? null : "outline"),
      /** Open the existing search and replacement controls. */
      "edit-find": () => setSideView("search"),
      /** Open the supported-file picker. */
      "palette-quickopen": () => setQuickOpen(true),
      /** Open the shared command picker. */
      "palette-open": () => setPalette(true),
      /** Open settings without changing document ownership. */
      "palette-settings": () => setSettings(true),
      /** Toggle the existing native-grid view. */
      "palette-raw": () => setShowRaw(value => !value),
      "palette-raw-refresh": workspace.handleRawGridRefresh,
      /** Open and refresh crash recovery. */
      "palette-recovery": () => { setRecoveryPromptOpen(true); void workspace.refreshRecovery(); },
      /** Toggle the existing AI pane. */
      "palette-ai": () => setShowAi(value => !value),
      "inline-chat": staging.openInlineChat,
      /** Show implemented workbench shortcuts. */
      "help-keys": () => setHelpOpen(true),
    },
    /** Reflect existing state owners in checked menu choices. */
    checked: (id) => id.startsWith("view-") && ["live", "source", "read", "split"].includes(id.slice(5)) ? effectiveViewMode === id.slice(5)
      : id.startsWith("nav-") ? navBasis === id.slice(4) : id === "palette-ai" ? showAi : id === "palette-raw" ? showRaw : undefined,
  });
  /** Capture a tree row in the current native workspace session. */
  function treeTarget(node: TreeNode) { return workspace.targetFor(node.path, node.directory, node.kind); }
  /** Use the same invocation guards for captured tree contexts and the top menus. */
  function runTreeCommand(id: string, node: TreeNode) { void workbench.run(id, treeTarget(node)); }
  useEffect(() => { setExplorerTarget(null); }, [workspace.generation]);
  useEffect(() => { if (workspace.createdTarget) setExplorerTarget(workspace.createdTarget); }, [workspace.createdTarget]);
  useEffect(() => {
    /** Route only implemented workbench shortcuts, respecting IME, dialogs and form inputs. */
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.isComposing || event.defaultPrevented || (event.target instanceof Element && event.target.closest('[role="dialog"],input,textarea,select'))) return;
      const key = event.key.toLowerCase();
      const id = key === "p" ? (event.shiftKey ? "palette-open" : "palette-quickopen") : key === "s" ? "file-save" : key === "," ? "palette-settings" : key === "i" && event.shiftKey ? "inline-chat" : key === "i" && event.altKey ? "palette-ai" : null;
      if (id && workbench.command(id)?.enabled) { event.preventDefault(); if (id === "inline-chat") event.stopPropagation(); void workbench.run(id); }
    };
    /** Capture only the workbench inline gesture before it can become a native Vim key. */
    const onInlineKey = (event: KeyboardEvent) => { if (event.shiftKey && event.key.toLowerCase() === "i") onKey(event); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keydown", onInlineKey, true);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("keydown", onInlineKey, true); };
  }, [workbench]);

  // -- derived view data --------------------------------------------------------

  /** Build sidebar tree nodes from entries or demo docs. */ const treeNodes = useMemo(() => {
    if (desktop) {
      return buildTree(workspace.entries);
    }
    return buildTree(
      Object.keys(session.docs).map((path) => ({ path, name: path.split("/").pop() ?? path, directory: false, markdown: true })),
    );
  }, [desktop, workspace.entries, session.docs]);

  const tabItems: TabItem[] = useMemo(
    () =>
      session.tabs.map((id) => {
        const doc = session.docs[id];
        return { id, label: fileLabel(session.imageTabs[id] ?? doc?.path ?? null, id), dirty: doc?.dirty ?? false };
      }),
    [session.tabs, session.docs, session.imageTabs],
  );

  /** Collect deduplicated quick-open paths from docs and entries. */ const quickPaths = useMemo(() => {
    const fromEntries = workspace.entries.filter((entry) => !entry.directory && entryKind(entry)).map((entry) => entry.path);
    const fromDocs = Object.values(session.docs).map((doc) => doc.path).filter((path): path is string => path !== null);
    return Array.from(new Set([...fromDocs, ...fromEntries, ...(desktop ? [] : Object.keys(session.demo))]));
  }, [desktop, workspace.entries, session.docs, session.demo]);

  /** Format the cursor as 1-based line:column or null. */ const cursorPos = useMemo(() => {
    if (!session.active) return null;
    const sel = session.selections[session.active.documentId] ?? { anchor: 0, head: 0 };
    try {
      const pos = offsetToLineCol(session.active.text, Math.min(sel.head, session.active.text.length));
      return `${pos.line + 1}:${pos.col + 1}`;
    } catch {
      return null;
    }
  }, [session.active, session.selections]);

  // Visible filename labels for AI scopes (never internal ids in product text).
  /** Map document IDs to visible filenames without internal IDs. */ const contextLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const doc of Object.values(session.docs)) {
      const base = doc.path?.split("/").pop() ?? doc.documentId;
      labels[doc.documentId] = base === "" ? doc.documentId : base;
    }
    return labels;
  }, [session.docs]);

  const activeExternal = session.active ? session.externalByDoc[session.active.documentId] : undefined;
  const isConflicted = session.active ? session.conflictDoc === session.active.documentId : false;

  // Exact AI scope, staging refs, and proposal intake live in useAiStaging
  // with the application staging service and generation fencing.


  return (
    <div data-theme={theme} data-testid="workspace-shell" style={{ "--editor-font-size": `${preferences.fontSize}px`, "--editor-line-height": preferences.lineHeight } as CSSProperties} className="marxen-workspace relative flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <WorkbenchMenuBar theme={theme} commands={workbench.commands} onRun={(id) => void workbench.run(id)} onPrepare={(origin) => void workbench.prepareEditor(origin)} />
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <nav aria-label={t("アクティビティ")} className="marxen-activity flex w-12 shrink-0 flex-col items-center border-r border-border bg-card py-1">
        {(
          [
            { id: "explorer", label: t("エクスプローラー"), icon: <Files size={19} aria-hidden="true" /> },
            { id: "search", label: t("検索"), icon: <Search size={19} aria-hidden="true" /> },
            { id: "outline", label: t("アウトライン"), icon: <ListTree size={19} aria-hidden="true" /> },
          ] as Array<{ id: SideView; label: string; icon: ReactNode }>
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setSideView((current) => (current === item.id ? null : item.id))}
            aria-pressed={sideView === item.id}
            aria-label={item.label}
            title={item.label}
            className={`relative flex h-11 w-full items-center justify-center border-l-2 hover:text-foreground ${sideView === item.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground"}`}
          >
            {item.icon}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setSettings(true)}
          aria-label={t("設定表示切替")}
          title={t("設定")}
          className="mt-auto flex h-11 w-full items-center justify-center text-muted-foreground hover:text-foreground"
        >
          <SettingsIcon size={19} aria-hidden="true" />
        </button>
      </nav>
      {sideView && (
        <WorkspaceSidebar>
          {sideView === "explorer" && (
            <div className="flex flex-col">
              <div className="flex h-10 shrink-0 items-center gap-1 px-4">
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">{t("エクスプローラー")}</span>
                {[
                  ["file-new", "新しいファイル", FilePlus2], ["folder-new", "新規フォルダー", FolderPlus], ["tree-refresh", "エクスプローラーを更新", RefreshCw],
                ].map(([id, label, Icon]) => {
                  const item = workbench.command(id as string)!;
                  const ActionIcon = Icon as typeof FilePlus2;
                  return <button key={id as string} type="button" aria-label={t(label as LabelKey)} title={item.reason ?? t(label as LabelKey)} disabled={!item.enabled || workspace.refreshing} onClick={() => void workbench.run(id as string)} className="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"><ActionIcon size={15} aria-hidden="true" /></button>;
                })}
              </div>
              <FileTree key={`${workspace.wsRoot ?? "demo"}:${workspace.generation}`} theme={theme} desktop={desktop} nodes={treeNodes} rootPath={workspace.wsRoot ?? undefined} rootName={workspace.wsRoot?.split(/[\\/]/).filter(Boolean).at(-1)} activePath={activeImage ?? active?.path ?? null} selectedPath={explorerTarget?.path ?? null}
                onSelect={(node) => setExplorerTarget(treeTarget(node))} onCommand={runTreeCommand}
                contextCommands={(node) => ["tree-open", "file-new", "folder-new", "file-rename", "tree-refresh"].map((id) => workbench.command(id, treeTarget(node))!)}
                onOpenFile={(path) => { void openFileForEditing(path); if (window.innerWidth < 768) setSideView(null); }} />
              {desktop && !workspace.wsRoot && <p className="px-4 py-3 text-xs leading-5 text-muted-foreground">{t("フォルダーが選択されていません。")}</p>}
            </div>
          )}
          {sideView === "search" && (
            <SearchPanel
              query={workspace.searchQuery}
              onQuery={workspace.setSearchQuery}
              hits={desktop ? workspace.registryHits : workspace.localHits}
              searching={workspace.searching}
              canReplace={desktop}
              replaceText={workspace.replaceText}
              onReplaceText={workspace.setReplaceText}
              onJump={(hit) => void workspace.jumpToHit(hit)}
              onReplaceOne={(hit) => void workspace.replaceOne(hit)}
              onReplaceAll={() => void workspace.replaceAllMatches()}
            />
          )}
          {sideView === "outline" && (
            <Outline
              text={active?.text ?? ""}
              onJump={(offset) => {
                if (active) void session.jumpToOffset(active.documentId, offset, offset);
              }}
            />
          )}
        </WorkspaceSidebar>
      )}

      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="marxen-editor-header flex h-10 shrink-0 items-center gap-1 border-b border-border bg-card pr-2">
          <div className="min-w-0 flex-1">
            <Tabs tabs={tabItems} activeId={activeId} onSelect={(id) => { session.setActiveId(id); const path = session.docsRef.current[id]?.path; if (path) setEditorFocus((previous) => ({ path, sequence: (previous?.sequence ?? 0) + 1 })); }} onClose={(id) => void session.closeTab(id)} />
          </div>
          {desktop && <button type="button" aria-label={t("チャットを切り替える")} aria-pressed={showAi} title={t("チャット (Ctrl+Alt+I)")} onClick={() => setShowAi((value) => !value)} className={`rounded-sm p-1.5 hover:bg-muted ${showAi ? "text-foreground" : "text-muted-foreground"}`}><MessageSquare size={16} aria-hidden="true" /></button>}
          <button
            type="button"
            onClick={() => void workbench.run("file-save")}
            disabled={!desktop || !active}
            title={desktop ? t("保存") : t("ブラウザ表示では編集できません。デスクトップで開いてください。")}
            aria-label={t("保存")}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            <Save size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setMoreOpen((value) => !value)}
            aria-expanded={moreOpen}
            data-editor-actions-trigger aria-label={t("その他の操作")}
            title={t("その他の操作")}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
          >
            <Ellipsis size={15} aria-hidden="true" />
          </button>
        </header>
        {(active || activeImage) && <div className="marxen-context-bar flex h-8 shrink-0 items-center gap-2 border-b border-border px-4 text-xs text-muted-foreground">
          <nav aria-label={t("ファイルの場所")} className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden" title={activeImage ?? active?.path ?? undefined}>
            {(activeImage ?? active?.path ?? t("無題")).split(/[\\/]/).filter(Boolean).map((part, index, parts) => <span key={index} className="flex min-w-0 items-center gap-1">
              {index > 0 && <ChevronRight size={12} className="shrink-0 opacity-50" aria-hidden="true" />}
              {index === parts.length - 1 && <FileText size={13} className="shrink-0 text-primary/70" aria-hidden="true" />}
              <span className={index === parts.length - 1 ? "truncate text-foreground/80" : "truncate max-sm:hidden"}>{part}</span>
            </span>)}
          </nav>
          <label className="sr-only" htmlFor="view-mode-select">{t("表示モード")}</label>
          <select
            id="view-mode-select"
            value={effectiveViewMode}
            disabled={!activeIsMarkdown}
            onChange={(event) => setViewMode(event.target.value as ViewMode)}
            aria-label={t("表示モード")}
            className="h-7 max-w-36 rounded bg-transparent px-1 text-xs text-muted-foreground hover:bg-muted"
          >
            {(Object.keys(MODE_LABEL) as ViewMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {t(MODE_LABEL[mode] as LabelKey)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setViewMode((mode) => mode === "split" ? "live" : "split")}
            aria-label={t("プレビューを横に開く")}
            disabled={!activeIsMarkdown}
            aria-pressed={viewMode === "split"}
            title={t("プレビューを横に開く")}
            className={`rounded p-1.5 hover:bg-muted ${viewMode === "split" ? "text-primary" : "text-muted-foreground"}`}
          >
            <PanelsLeftRight size={16} aria-hidden="true" />
          </button>

        </div>}
        {activeIsMarkdown && effectiveViewMode !== "read" && <GuiToolbar
          onFormat={(kind: FormatKind) => vim.guiAtSelection((text, start, end) => formatRange(text, start, end, kind), kind === "bold" || kind === "strike" ? 2 : 1)}
          onCheckbox={() => vim.guiAtSelection((text, _start, end) => toggleCheckbox(text, end))}
          onTable={(rows, columns) => vim.guiAtSelection((text, start, end) => {
            const inserted = insertTable(start, rows, columns, t("表の見出し"))[0];
            const prefix = start > 0 && text[start - 1] !== "\n" ? "\n\n" : "";
            const suffix = end < text.length && text[end] !== "\n" ? "\n" : "";
            return [{ range: { start, end }, text: prefix + inserted.text + suffix }];
          })}
          onTableAction={(action) => vim.guiAtSelection((text, _start, end) => tableActionEdits(text, end, action))}
          tableCell={active ? tableCellAt(active.text, selections[active.documentId]?.head ?? 0) : null}
          onLink={() => vim.guiAtSelection((text, start, end) => insertLink(text, start, end, "https://example.com"))}
          onImage={() => vim.guiAtSelection((text, start, end) => insertImage(text, start, end, "images/paste.png"))}
          onUndo={() => void session.handleUndo()}
          onRedo={() => void session.handleRedo()}
          hardBreakOnEnter={preferences.hardBreakOnEnter}
          onHardBreakOnEnter={(enabled) => updatePreferences({ ...preferences, hardBreakOnEnter: enabled })}
          disabled={!desktop}
        />}
        {editorMenu.state && <EditorMenu {...editorMenu.state} markdown={activeIsMarkdown} disabled={!desktop} onDismiss={editorMenu.dismiss} onAction={(action) => void editorMenu.act(action)} onFormat={(kind) => void editorMenu.format(kind)} />}
        {moreOpen && (
          <EditorActionsPopover onClose={() => setMoreOpen(false)}>
            <div role="group" aria-label={t("移動基準")} className="my-1 flex items-center gap-1 border-y border-border px-2 py-2">
              {(["display", "source"] as NavBasis[]).map((basis) => (
                <button
                  key={basis}
                  type="button"
                  onClick={() => {
                    setNavBasis(basis);
                    setMoreOpen(false);
                  }}
                  aria-pressed={navBasis === basis}
                  title={basis === "display" ? t("折り返し行の上下・行頭末は表示基準で移動します") : t("上下・行頭末・単語・テキストオブジェクト・マクロは実 Neovim のVim の移動で動作します")}
                  className={`rounded-md px-2 py-1 text-xs ${navBasis === basis ? "bg-primary text-primary-foreground" : "border border-border"}`}
                >
                  {basis === "display" ? t("表示行") : "Vim"}
                </button>
              ))}
            </div>
            <div role="menu" data-editor-actions-trigger aria-label={t("その他の操作")} className="py-1">
              {(
                [
                  ...["palette-raw", "palette-quickopen", "palette-open", "inline-chat", "file-new", "file-rename", "file-reload", "file-close", "palette-recovery", "palette-settings"].map((id) => [id, workbench.command(id)!.label]),
                ] as Array<[string, string]>
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="menuitem"
                  aria-label={label}
                  disabled={!workbench.command(id)?.enabled}
                  title={workbench.command(id)?.reason}
                  onClick={() => {
                    setMoreOpen(false);
                    void workbench.run(id);
                  }}
                  className="flex h-8 w-full items-center justify-between gap-3 rounded-sm px-2 text-left text-[13px] hover:bg-muted focus:bg-muted focus:outline-none"
                >
                  <span>{label}</span>
                  <kbd className="text-[11px] text-muted-foreground">{workbench.command(id)?.shortcut ?? ""}</kbd>
                </button>
              ))}
            </div>
          </EditorActionsPopover>
        )}

          {notice && <NotificationToast theme={theme} position={preferences.notificationPosition} notice={notice} onDismiss={dismissNotice} />}
          {activeExternal && active && activeExternal !== dismissedExternal && (
            <NotificationToast theme={theme} position={preferences.notificationPosition} testId="external-banner" raised={notice !== null}
              notice={{ id: 0, kind: "info", message: t("{{value0}}{{value1}}", { value0: (activeExternal.deleted ? t("ファイルが外部で削除されました。") : t("ファイルが外部で変更されました。")), value1: (active.dirty ? t("未保存の変更を保持しています。") : "") }) }}
              onDismiss={() => setDismissedExternal(activeExternal)}
              actions={!active.dirty && !activeExternal.deleted ? (
                <button type="button" onClick={() => void session.handleReload()} className="rounded-md border border-border px-3 py-1">
                  {t("再読込する")}</button>
              ) : undefined} />
          )}
          {isConflicted && active && (
            <WorkspaceDialog theme={theme} label={t("保存競合")} testId="conflict-banner" onDismiss={() => session.setConflictDoc(null)}>
              <p className="mb-3">{t("ディスク上のファイルが変更されています。本文は保持しています。")}</p>
              <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  const id = active.documentId;
                  const current = session.docsRef.current[id];
                  if (!current) return;
                  void (async () => {
                    try {
                      await workspaceGateway!.closeDocument({ documentId: id, baseRevision: current.revision }, "discard");
                      const open = await workspaceGateway!.openMarkdown(active.path ?? "");
                      const doc = docFromOpen(open);
                      session.setDocs((prev) => ({ ...prev, [doc.documentId]: doc }));
                      session.setTabs((prev) => prev.map((tab) => (tab === id ? doc.documentId : tab)));
                      session.setActiveId(doc.documentId);
                      session.setConflictDoc(null);
                      setNotice(message("最新のMarkdownに再読込しました（未保存の変更は破棄）。"));
                    } catch (cause) {
                      setNotice(localizedFailure(cause, workspaceErrorText));
                    }
                  })();
                }}
                className="rounded-md border border-border px-3 py-1"
              >
                {t("再読込（未保存を破棄）")}</button>
              <button type="button" onClick={() => session.setConflictDoc(null)} className="rounded-md border border-border px-3 py-1">
                {t("保持する")}</button>
              </div>
            </WorkspaceDialog>
          )}
          {recoveryPromptOpen && workspace.recovery.length > 0 && !session.closeDecision && !isConflicted && !workspace.newFileOpen && !workspace.renameDoc && (
            <WorkspaceDialog theme={theme} label={t("未保存の文書を復元")} testId="recovery-dialog" onDismiss={() => setRecoveryPromptOpen(false)}>
              <p className="mb-3 text-muted-foreground">{t("前回終了時の未保存の変更があります。復元する文書を選んでください。")}</p>
              <ul className="divide-y divide-border">
                {workspace.recovery.map((entry) => (
                  <li key={entry.documentId} className="flex flex-wrap items-center gap-2 py-2">
                    <span className="min-w-0 flex-1 break-words" title={entry.path ?? undefined}>
                      {entry.path ?? entry.documentId}
                      {entry.conflict ? t("（ディスクも変更あり）") : ""}
                    </span>
                    <button type="button" onClick={() => void workspace.restoreEntry(entry.documentId, false)} className="rounded border border-border px-2 py-1">
                      {t("復元する")}</button>
                    <button type="button" onClick={() => void workspace.restoreEntry(entry.documentId, true)} className="rounded border border-border px-2 py-1">
                      {t("破棄する")}</button>
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex justify-end"><button type="button" onClick={() => setRecoveryPromptOpen(false)} className="rounded-md border border-border px-3 py-1">{t("後で")}</button></div>
            </WorkspaceDialog>
          )}
          {session.closeDecision && (
            <WorkspaceDialog theme={theme} label={t("閉じる確認")} testId="close-dialog" onDismiss={() => void session.resolveCloseDecision("cancel")}>
              <p className="mb-2">{t("未保存の変更があります。どうしますか。")}</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => void session.resolveCloseDecision("save")} className="rounded-md border border-border px-3 py-1">
                  {t("保存して閉じる")}</button>
                <button type="button" onClick={() => void session.resolveCloseDecision("discard")} className="rounded-md border border-border px-3 py-1">
                  {t("破棄して閉じる")}</button>
                <button type="button" onClick={() => void session.resolveCloseDecision("cancel")} className="rounded-md border border-border px-3 py-1">
                  {t("キャンセル")}</button>
              </div>
            </WorkspaceDialog>
          )}
          {workspace.newFileOpen && (
            <WorkspaceDialog theme={theme} label={t(workspace.entryKind === "folder" ? "新規フォルダー" : "新規Markdownファイル")} onDismiss={() => workspace.setNewFileOpen(false)}>
              <form onSubmit={(event) => { event.preventDefault(); void workspace.createFile(); }} className="flex flex-wrap items-center gap-2">
              <input
                value={workspace.newFilePath}
                onChange={(event) => workspace.setNewFilePath(event.target.value)}
                placeholder={workspace.entryKind === "folder" ? t("メモ/新しいフォルダー") : "notes/new.md"}
                aria-label={t(workspace.entryKind === "folder" ? "新規フォルダーのパス" : "新規ファイルのパス")}
                className="min-w-40 flex-1 rounded-md border border-border bg-background px-3 py-1.5"
              />
              <button type="submit" disabled={workspace.busy} className="rounded-md border border-border px-3 py-1">
                {t("作成する")}</button>
              <button type="button" onClick={() => workspace.setNewFileOpen(false)} className="rounded-md border border-border px-3 py-1">
                {t("閉じる")}</button>
              </form>
            </WorkspaceDialog>
          )}
          {workspace.renameDoc && (
            <WorkspaceDialog theme={theme} label={t("名前の変更")} onDismiss={() => workspace.setRenameDoc(null)}>
              <form onSubmit={(event) => { event.preventDefault(); void workspace.renameFile(); }} className="flex flex-wrap items-center gap-2">
              <input
                value={workspace.renamePath}
                onChange={(event) => workspace.setRenamePath(event.target.value)}
                placeholder="メモ/新名.md"
                aria-label={t("新しいパス")}
                className="min-w-40 flex-1 rounded-md border border-border bg-background px-3 py-1.5"
              />
              <button type="submit" disabled={workspace.busy} className="rounded-md border border-border px-3 py-1">
                {t("変更する")}</button>
              <button type="button" onClick={() => workspace.setRenameDoc(null)} className="rounded-md border border-border px-3 py-1">
                {t("閉じる")}</button>
              </form>
            </WorkspaceDialog>
          )}

        <main
          className="grid min-h-0 min-w-0 flex-1 overflow-hidden"
          style={{ gridTemplateColumns: effectiveViewMode === "split" && activeIsMarkdown && active ? `minmax(0, ${splitRatio}fr) 5px minmax(0, ${100 - splitRatio}fr)` : "minmax(0, 1fr)" }}
          aria-label={t("編集領域")}
        >
          {/* One editor-primary at a time: live owns the inline preview
              pane, source/split own the raw pane. Selections live in shell
              state so scroll/cursor survive mode switches. */}
          {activeImage ? <ImageViewer key={activeImage} path={activeImage} loadImage={(path) => workspaceGateway!.loadWorkspaceImage(path)} /> : active ? (
            effectiveViewMode === "live" ? (
              <ImageDropZone desktop={desktop} subscribeNativeDrop={dropGateway?.listen} enabled={desktop && activeIsMarkdown} selection={image.dropSelection} onDrop={image.handleImageDrop} onError={setNotice}>
              <div onKeyDownCapture={vim.onEditorKeyDown} onPasteCapture={image.onPasteCapture} className="h-full min-h-0 min-w-0">
                <CodeMirrorEditor
                  key={`live-${active.documentId}`}
                  value={active.text}
                  editable={desktop}
                  ariaLabel={t("{{value0}}の{{value1}}エディタ", { value0: (active.path ?? active.documentId), value1: (activeIsMarkdown ? "Markdown" : t("テキスト")) })}
                  testId="editor-primary"
                  onEditorMenu={(point) => void editorMenu.open(point)}
                  focusRequest={editorFocus?.path === active.path ? editorFocus.sequence : 0}
                  initialSelection={selections[active.documentId] ?? null}
                  externalCursor={cursorEcho[active.documentId] ?? null}
                  livePreview
                  preferences={preferences}
                  vimMode={vimMode}
                  allowTextInput={vimMode === "insert" || vimMode === "replace"}
                  resolveImage={image.liveResolver}
                  snapshot={active}
                  shouldUseNativeCursor={() => vim.isNativeInputPending(active.documentId)}
                  onGuiEdits={(edits, beforeText, selection, key, nativeCursor) => vim.routeGuiEdits(active.documentId, edits, beforeText, selection, key, nativeCursor)}
                  onSelectionChange={(selection) => session.handleSelection(active.documentId, selection)}
                />
              </div>
              </ImageDropZone>
            ) : (
              <ImageDropZone desktop={desktop} subscribeNativeDrop={dropGateway?.listen} hidden={effectiveViewMode === "read"} enabled={desktop && activeIsMarkdown && effectiveViewMode !== "read"} selection={image.dropSelection} onDrop={image.handleImageDrop} onError={setNotice}>
              <div
                onKeyDownCapture={vim.onEditorKeyDown}
                onPasteCapture={image.onPasteCapture}
                className={effectiveViewMode === "read" ? "hidden" : "flex h-full min-h-0 min-w-0 flex-col"}
                aria-hidden={effectiveViewMode === "read"}
              >
                {effectiveViewMode === "split" && <div className="flex h-7 shrink-0 items-center border-b border-border px-3 text-xs text-muted-foreground">Markdown</div>}
                <CodeMirrorEditor
                  key={`primary-${active.documentId}`}
                  value={active.text}
                  editable={desktop}
                  ariaLabel={t("{{value0}}の{{value1}}エディタ", { value0: (active.path ?? active.documentId), value1: (activeIsMarkdown ? "Markdown" : t("テキスト")) })}
                  testId="editor-primary"
                  onEditorMenu={(point) => void editorMenu.open(point)}
                  focusRequest={editorFocus?.path === active.path ? editorFocus.sequence : 0}
                  preferences={preferences}
                  vimMode={vimMode}
                  allowTextInput={vimMode === "insert" || vimMode === "replace"}
                  initialSelection={selections[active.documentId] ?? null}
                  externalCursor={cursorEcho[active.documentId] ?? null}
                  snapshot={active}
                  shouldUseNativeCursor={() => vim.isNativeInputPending(active.documentId)}
                  onGuiEdits={(edits, beforeText, selection, key, nativeCursor) => vim.routeGuiEdits(active.documentId, edits, beforeText, selection, key, nativeCursor)}
                  onSelectionChange={(selection) => session.handleSelection(active.documentId, selection)}
                />
              </div>
              </ImageDropZone>
            )
          ) : (
            <div className="flex h-full items-center justify-center p-8">
              <div className="w-full max-w-sm">
                <FileText size={36} strokeWidth={1} className="mb-5 text-muted-foreground/40" aria-hidden="true" />
                <h1 className="text-2xl font-semibold tracking-tight">Marxen</h1>
                <p className="mt-2 text-sm text-muted-foreground">{t("Markdown を書くためのワークスペース")}</p>
                <div className="mt-8 flex flex-col gap-1">
                  {desktop && <p className="text-xs text-muted-foreground">{t("ファイルメニューからフォルダーを開いてください。")}</p>}
                  <button type="button" onClick={() => setQuickOpen(true)} className="flex h-10 items-center justify-between rounded px-2 text-left text-sm hover:bg-muted"><span className="flex items-center gap-3"><Search size={16} className="text-muted-foreground" />{t("ファイルを探す")}</span><kbd className="text-xs text-muted-foreground">Ctrl+P</kbd></button>
                  <button type="button" onClick={() => setPalette(true)} className="flex h-10 items-center justify-between rounded px-2 text-left text-sm hover:bg-muted"><span className="flex items-center gap-3"><Ellipsis size={16} className="text-muted-foreground" />{t("コマンドを実行")}</span><kbd className="text-xs text-muted-foreground">Ctrl+Shift+P</kbd></button>
                </div>
              </div>
            </div>
          )}
          {effectiveViewMode === "read" && activeIsMarkdown && active && (
            <div className="min-h-0 min-w-0">
              <MarkdownPreview key={`read-${active.documentId}`} text={active.text} resolveImage={image.readResolver} />
            </div>
          )}
          {effectiveViewMode === "split" && active && (
            <>
              <div
                role="separator"
                aria-label={t("Markdown とプレビューの幅")}
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
                <div className="flex h-7 shrink-0 items-center border-b border-border px-3 text-xs text-muted-foreground">{t("プレビュー")}</div>
                <div className="min-h-0 flex-1">
                  <MarkdownPreview key={`split-${active.documentId}`} text={active.text} resolveImage={image.readResolver} />
                </div>
              </div>
            </>
          )}
        </main>

        {showRaw && active && (
          <div className="shrink-0 px-2 pb-2">
            <RawGridView
              text={active.text}
              revision={workspace.gridRev ?? active.revision}
              onRefresh={workspace.handleRawGridRefresh}
              grid={workspace.nvimGrid}
              onVimKeys={desktop ? workspace.handleRawGridKeys : undefined}
            />
          </div>
        )}

        <footer className="marxen-status flex h-6 shrink-0 items-center gap-3 whitespace-nowrap border-t border-border bg-card px-3 text-[11px] text-muted-foreground">
          {desktop && active && <span data-testid="vim-footer-mode" className="flex h-5 shrink-0 items-center rounded-sm bg-primary/10 px-1.5 font-medium text-primary">{MODE_JA[vimMode] ? t(MODE_JA[vimMode] as LabelKey) : vimMode}</span>}
          <span className="min-w-0 flex-1 truncate">{workspace.wsRoot?.split(/[\\/]/).filter(Boolean).at(-1) ?? ""}</span>
          {cursorPos && <span data-testid="cursor" title={t("カーソル位置")}><span className="sr-only">{t("カーソル")}{" "}</span>{cursorPos}</span>}
          <span data-testid="dirty">{!active || active.dirty ? (active ? t("未保存") : "—") : t("保存済み")}</span>
          {desktop && session.copyReady === activeId && <span data-testid="copy-ready" className="min-w-0 max-w-72 truncate" title={Object.entries(workspace.copyKeys).map(([format, key]) => `${key} ${t(COPY_LABELS[format as keyof typeof COPY_LABELS] as LabelKey)}`).join(" / ")}>{t("コピー形式を選択")}</span>}
          {!desktop && <span data-testid="readonly-note">{t("ブラウザ表示は読み取り専用です")}</span>}
          <span role="status" className="shrink-0">
            {workspace.runtime ? (workspace.runtime.connection === "disconnected" ? t("Neovim 未接続") : workspace.runtime.connection === "connected" ? t("Neovim 接続済み") : workspace.runtime.detail) : t("接続状態を確認中…")}
          </span>
          <details className="relative shrink-0">
            <summary aria-label={t("エディターの接続情報")} title={t("エディターの接続情報")} className="flex cursor-pointer list-none items-center rounded-sm p-0.5 hover:bg-muted"><Info size={13} aria-hidden="true" /></summary>
            <div className="absolute bottom-7 right-0 z-20 min-w-44 rounded border border-border bg-card p-3 shadow-lg">
          <span data-testid="revision" className="block">{t("リビジョン {{value0}}", { value0: active?.revision ?? "—" })}</span>
              {desktop && session.vimKeys !== "" && <span data-testid="vim-keys" className="mt-1 block">{t("Vim入力 {{value0}}", { value0: session.vimKeys })}</span>}
            </div>
          </details>
        </footer>

        <QuickOpen
          open={quickOpen}
          paths={quickPaths}
          label={t("クイックオープン")}
          testId="quick-open"
          onSelect={(path) => void openFileForEditing(path)}
          onClose={() => setQuickOpen(false)}
        />
          {staging.inlineOpen && staging.inlineSnapshot && active && staging.inlineSnapshot.documentId === active.documentId && (
          <div data-testid="inline-chat-anchor">
            <InlineChat
              key={`${staging.inlineSnapshot.documentId}:${staging.inlineSnapshot.revision}:${staging.inlineSnapshot.ranges[0]?.start}:${staging.inlineSnapshot.ranges[0]?.end}`}
              anchor={staging.inlineAnchor}
              documentId={staging.inlineSnapshot.documentId}
              documentLabel={contextLabels[staging.inlineSnapshot.documentId] ?? t("現在の文書")}
              target={{
                start: staging.inlineSnapshot.ranges[0]?.start ?? 0,
                end: staging.inlineSnapshot.ranges[0]?.end ?? 0,
                kind: staging.inlineKind,
                excerpt: staging.inlineSnapshot.text,
              }}
              context={staging.inlineSnapshot}
              staging={staging.staging}
              ensureStaging={(contexts) => staging.ensureStagingFor(contexts, "inline")}
              modelControls={modelControls}
              provider={aiProvider}
              disabled={staging.agentBusy}
              onBusyChange={staging.setInlineChatBusy}
              onProposal={staging.handleProposal}
              onReview={() => { setShowAi(true); void staging.fetchReviewDiff(); }}
              onClose={staging.closeInlineChat}
              startPrompt={aiGateway?.startPrompt}
              aiGateway={aiGateway}
            />
          </div>
        )}
        <CommandPalette open={palette} commands={workbench.commands} onRun={(id) => void workbench.run(id)} onClose={() => setPalette(false)} />
        {manualFolder && <WorkspaceDialog theme={theme} label={t("フォルダーを開く")} onDismiss={() => setManualFolder(false)}>
          <form onSubmit={(event) => { event.preventDefault(); void workspace.openWorkspaceFolder(folderInput); }} className="flex flex-wrap gap-2">
            <input value={folderInput} onChange={(event) => setFolderInput(event.target.value)} placeholder={t("フォルダーの絶対パス…")} aria-label={t("開くフォルダーの絶対パス")} className="min-w-0 flex-1 rounded-sm border border-border bg-background px-2 py-1" />
            <button type="submit" disabled={workspace.busy} className="rounded-sm border border-border px-3 py-1">{t("開く")}</button>
          </form>
        </WorkspaceDialog>}
        {helpOpen && <WorkspaceDialog theme={theme} label={t("キーボードショートカット")} onDismiss={() => setHelpOpen(false)}>
          <dl className="space-y-2">{workbench.commands.filter((item) => item.shortcut).map((item) => <div key={item.id} className="flex justify-between gap-3"><dt>{item.label}</dt><dd><kbd>{item.shortcut}</kbd></dd></div>)}</dl>
          <p className="mt-3 text-xs text-muted-foreground">{t("Vimのキー操作は現在の設定に従います。編集メニューで実際のマッピングを確認できます。")}</p>
        </WorkspaceDialog>}
        {settings && (
          <SettingsPanel
            languagePreference={props.languagePreference}
            onLanguagePreference={props.onLanguagePreference}
            theme={theme}
            onTheme={setTheme}
            preferences={preferences}
            onPreferences={updatePreferences}
            aiSettings={<AiProviderSettings embedded provider={aiProvider} onProvider={setAiProvider} gateway={aiGateway} profileStore={aiProfileStore} />}
            aiVisibilitySettings={<AiVisibilitySettings preferences={aiView.preferences} onPreferences={aiView.updatePreferences} advertisedProviders={aiModels.advertisedProviders} saveFailed={aiView.saveFailed} />}
            vimSettings={desktop && vimSettingsGateway ? <VimSettingsHost gateway={vimSettingsGateway} initialPath={workspace.configPath} onSaved={workspace.setConfigPath} dialogGateway={dialogGateway} /> : undefined}
            configPath={workspace.configPath}
            configError={workspace.configError}
            onConfigPath={workspace.setConfigPath}
            onBrowseConfig={
              desktop
                ? () =>
                    void (async () => {
                      const picked = await dialogGateway!.pickConfigFile(t("Neovim 設定ファイル"));
                      if (picked) workspace.setConfigPath(picked);
                    })()
                : undefined
            }
            onApplyConfig={() => void workspace.applyConfig()}
            applyingConfig={workspace.applyingConfig}
            currentConfig={workspace.currentConfig}
            copyKeys={workspace.copyKeys}
            onClose={() => setSettings(false)}
          />
        )}
      </div>

      {desktop && (
        <ResizableAiPane visible={showAi} width={aiView.preferences.chatPaneWidth} onWidth={(chatPaneWidth) => aiView.updatePreferences({ ...aiView.preferences, chatPaneWidth })}>
          <div className="flex min-h-0 flex-1 flex-col">
          <AiPanel
            headerActions={aiUsageGateway ? <AiUsagePopover gateway={aiUsageGateway} accountGateway={codexAccountUsageGateway} theme={theme} /> : undefined}
            modelControls={modelControls}
            contexts={staging.aiContexts}
            staging={staging.staging}
            ensureStaging={(contexts) => staging.ensureStagingFor(contexts, "agent")}
            provider={aiProvider}
            onProvider={setAiProvider}
            onClose={() => setShowAi(false)}
            contextLabels={contextLabels}
            disabled={staging.inlineBusy}
            onBusyChange={staging.setAgentChatBusy}
            onRemoveContext={() => staging.setAiDismissed(true)}
            onProposal={staging.handleProposal}
            startPrompt={aiGateway?.startPrompt}
            profileStore={aiProfileStore}
            aiGateway={aiGateway}
          />
          </div>
          <div className="max-h-72 min-h-0 overflow-y-auto">
            <ReviewPanel
              documentLabels={contextLabels}
              copyId={staging.staging?.copyId ?? null}
              diffs={staging.diffs}
              newFiles={staging.newFiles}
              importOutcomes={staging.importOutcomes}
              applied={staging.applied}
              outcomes={staging.outcomes}
              busy={staging.reviewBusy || staging.agentBusy || staging.inlineBusy}
              message={staging.reviewMessage}
              status={staging.reviewStatus}
              proposalText={staging.aiProposal?.proposal.text ?? null}
              onFetchDiff={() => void staging.fetchReviewDiff()}
              onStageProposal={staging.aiProposal && staging.aiProposal.mode !== "ask" && staging.staging && staging.reviewMessage ? () => void staging.stageStoredProposal() : null}
              onApprove={() => void staging.approveStaging()}
              onReject={() => void staging.rejectStaging()}
              onCancel={() => void staging.cancelStaging()}
              onRetryImports={staging.importOutcomes.some((item) => !item.ok) ? () => void staging.retryImports() : null}
            />
          </div>
          {staging.aiDismissed && active && (
            <button type="button" onClick={() => staging.setAiDismissed(false)} className="mt-2 w-full rounded-md border border-border px-3 py-1.5 text-xs">
              {t("現在の選択を送る")}</button>
          )}
          {staging.aiProposal && staging.aiProposal.mode !== "ask" && (
            <details data-testid="ai-proposal" className="mt-3 max-h-48 min-h-0 overflow-y-auto border-t border-border pt-2 text-xs">
              <summary className="cursor-pointer text-muted-foreground">{t("提案の Markdown")}</summary>
              <p className="font-medium">{t("AI の提案")}</p>
              <p className="mt-1 whitespace-pre-wrap">{staging.aiProposal.proposal.text}</p>
              <p
                className="mt-1 text-muted-foreground"
                title={staging.aiProposal.proposal.baseContexts.map((ref) => `rev ${ref.revision}`).join(", ")}
              >
                {t("対象:")}{staging.aiProposal.proposal.baseContexts.map((ref) => contextLabels[ref.documentId] ?? t("現在の文書")).join(", ")}
              </p>
              <p className="mt-1 text-muted-foreground">{t("適用は上の差分レビューで行います。")}</p>
              <button type="button" onClick={() => staging.setAiProposal(null)} className="mt-2 w-full rounded-md border border-border px-3 py-1.5">
                {t("却下する")}</button>
            </details>
          )}
        </ResizableAiPane>
      )}
      {aiVisibilityOpen && <AiVisibilityDialog preferences={aiView.preferences} onPreferences={aiView.updatePreferences} advertisedProviders={aiModels.advertisedProviders} saveFailed={aiView.saveFailed} onClose={closeAiVisibility} />}
      </div>
    </div>
  );
}














