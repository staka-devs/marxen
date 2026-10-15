import { useEffect, useRef, useState } from "react";
import type { EditorContext } from "../../../contracts/contracts";
import type { ExplorerTarget, WorkbenchCommand, WorkbenchMenu } from "../../../contracts/workbench";
import type { LabelKey, LocalizedText } from "../../../contracts/localization";
import type { EditorAction } from "../../../application/ports";
import { supportsEditorSelection } from "../../../domain/editor-menu";
import { localizedFailure } from "../../../domain/localization";
import { StaleResync, workspaceErrorText } from "../../../domain/document-errors";
import { useI18n } from "../../i18n/I18nProvider";
import type { DocumentSession } from "./useDocumentSession";
import type { WorkspaceHandle } from "./useWorkspace";

interface Args {
  desktop: boolean;
  session: DocumentSession;
  workspace: WorkspaceHandle;
  target: ExplorerTarget | null;
  /** Surface native failures through the shell's notification owner. */
  notify: (text: LocalizedText | null) => void;
  /** State-only commands supplied by the shell that owns their views and dialogs. */
  uiActions: Record<string, () => void>;
  /** Report checked state without moving view preferences into a second owner. */
  checked: (id: string) => boolean | undefined;
  /** Open a supported tree path and focus its existing editor or image view. */
  openFile: (path: string) => Promise<void>;
}

const DEFINITIONS: Array<[string, WorkbenchMenu, LabelKey, string?]> = [
  ["file-new", "file", "新規Markdownファイル"], ["folder-new", "file", "新規フォルダー"],
  ["folder-open", "file", "フォルダーを開く"], ["folder-path", "file", "パスを入力する"],
  ["folder-add", "file", "ワークスペースにフォルダーを追加"], ["file-save", "file", "保存", "Ctrl/Cmd+S"],
  ["file-rename", "file", "名前を変更"], ["file-reload", "file", "再読込"], ["file-close", "file", "閉じる"],
  ["edit-undo", "edit", "元に戻す"], ["edit-redo", "edit", "やり直す"], ["edit-cut", "edit", "選択範囲を切り取る"],
  ["edit-copy", "edit", "選択範囲をコピー"], ["edit-paste", "edit", "クリップボードから貼り付け"], ["edit-find", "edit", "検索"],
  ["selection-all", "selection", "すべて選択"],
  ["view-live", "view", "ライブプレビュー"], ["view-source", "view", "Markdown"], ["view-read", "view", "プレビュー"], ["view-split", "view", "分割表示"],
  ["view-explorer", "view", "エクスプローラー"], ["view-search", "view", "検索"], ["view-outline", "view", "アウトライン"],
  ["palette-raw", "view", "Neovim 画面"], ["palette-raw-refresh", "view", "Neovim 画面を更新する"], ["tree-refresh", "view", "エクスプローラーを更新"],
  ["palette-ai", "view", "AI 支援"], ["palette-settings", "view", "設定", "Ctrl/Cmd+,"],
  ["palette-quickopen", "go", "クイックオープン", "Ctrl/Cmd+P"], ["nav-display", "go", "表示行"], ["nav-source", "go", "Vim の移動"],
  ["inline-chat", "go", "インラインチャット", "Ctrl/Cmd+Shift+I"], ["palette-recovery", "go", "復旧一覧"],
  ["palette-open", "help", "コマンドパレット", "Ctrl/Cmd+Shift+P"], ["help-keys", "help", "キーボードショートカット"],
  ["tree-open", "go", "開く"],
];
const MENU_LABELS: Record<WorkbenchMenu, LabelKey> = { file: "ファイル", edit: "編集", selection: "選択", view: "表示", go: "移動", help: "ヘルプ" };
const PALETTE_LABELS: Record<string, LabelKey> = {
  "file-save": "ファイル: 保存する", "file-reload": "ファイル: 再読込する", "file-close": "ファイル: 閉じる", "file-rename": "ファイル: 名前を変更する",
  "edit-undo": "編集: 元に戻す", "edit-redo": "編集: やり直す", "view-live": "表示: ライブにする", "view-source": "表示: Markdownにする", "view-read": "表示: 閲覧にする", "view-split": "表示: 分割にする",
  "nav-display": "移動: 表示基準にする", "nav-source": "移動: Vim の移動にする", "palette-quickopen": "移動: ファイルをすばやく開く",
};

/** One consumed dispatcher for menus, tree actions, palette and workbench shortcuts. */
export function useWorkbenchCommands(args: Args) {
  const { t } = useI18n();
  const latest = useRef(args); latest.current = args;
  const [context, setContext] = useState<EditorContext | null>(null);
  const captured = useRef<EditorContext | null>(null);
  const editor = useRef<HTMLElement | null>(null);
  const restoreEditor = useRef<HTMLElement | null>(null);
  const captureSequence = useRef(0);
  useEffect(() => {
    /** Remember the exact editor view before workbench controls or a picker take focus. */
    const remember = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest(".cm-editor")) editor.current = target;
      else if (target.matches("input,textarea,select,[contenteditable=true]")) editor.current = null;
    };
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, []);

  /** Capture the native editor before a menu or palette moves its focus. */
  async function prepareEditor(origin: HTMLElement | null) {
    const { session, desktop, notify } = latest.current;
    const sequence = ++captureSequence.current;
    captured.current = null; setContext(null);
    if (origin?.closest(".cm-editor")) editor.current = origin;
    else if (origin?.matches("input,textarea,select,[contenteditable=true]") || !editor.current?.isConnected) { editor.current = null; return; }
    const id = session.activeRef.current;
    if (!desktop || !session.registry || !id || !editor.current) return;
    restoreEditor.current = editor.current;
    try {
      const next = await session.registry.fetchEditorContext(id);
      if (sequence !== captureSequence.current || id !== session.activeRef.current) return;
      captured.current = next; setContext(next);
    } catch (cause) { if (cause instanceof StaleResync) session.sayStale(cause.snapshot); else notify(localizedFailure(cause, workspaceErrorText)); }
  }

  /** Compute capabilities from current owners, also used at invocation time. */
  function command(id: string, override?: ExplorerTarget): WorkbenchCommand | undefined {
    const definition = DEFINITIONS.find((item) => item[0] === id);
    if (!definition) return undefined;
    const { desktop, session, workspace, target, checked } = latest.current;
    const location = override ?? target ?? workspace.targetFor();
    const native = desktop && !!session.registry && workspace.canOperate();
    const doc = session.activeRef.current ? session.docsRef.current[session.activeRef.current] : undefined;
    const current = captured.current;
    const editorReady = native && !!doc && !!current && current.cursor.documentId === doc.documentId && current.cursor.revision === doc.revision && current.mode === session.vimModeRef.current && supportsEditorSelection(current.mode);
    const selected = current !== null && current.cursor.anchor !== current.cursor.head;
    let enabled = true;
    let reason: LabelKey = "操作できる文書がありません。";
    if (["folder-open", "folder-path"].includes(id)) enabled = native;
    if (["file-new", "folder-new", "tree-refresh", "tree-open", "file-rename"].includes(id)) {
      enabled = native && workspace.isTargetCurrent(location);
      reason = "フォルダーを開いてください。";
      if (id === "tree-open") enabled = enabled && !location.directory;
      if (id === "file-rename") {
        if (location.directory) {
          enabled = enabled && location.path !== "";
          reason = "ルートフォルダーの名前は変更できません。";
        } else {
          enabled = enabled && (location.kind === "markdown" || location.kind === "text" || location.kind === "image");
          reason = "対応するテキスト・画像・フォルダーのみ名前を変更できます。";
        }
      }
    }
    if (["file-save", "file-reload", "palette-raw-refresh", "inline-chat"].includes(id)) enabled = native && !!doc;
    if (id === "palette-raw") enabled = !!doc && (!desktop || native);
    if (["view-live", "view-source", "view-read", "view-split", "nav-display", "nav-source"].includes(id)) enabled = !!doc && (id === "view-source" || id.startsWith("nav-") || doc.path === null || /\.(md|markdown)$/i.test(doc.path));
    if (id === "file-close") enabled = native && !!session.activeRef.current;
    if (id === "palette-ai" || id === "palette-recovery") enabled = native;
    if (id.startsWith("edit-") && id !== "edit-find") {
      enabled = editorReady && (id === "edit-copy" || !!current?.presentation.editable) && (!["edit-copy", "edit-cut"].includes(id) || selected);
      reason = "現在のエディターの選択またはVimモードでは操作できません。";
    }
    if (id === "selection-all") { enabled = editorReady; reason = "現在のエディターの選択またはVimモードでは操作できません。"; }
    if (id === "folder-add") { enabled = false; reason = "現在は単一フォルダーのみ対応しています。"; }
    if (!desktop && !enabled) reason = "デスクトップで利用できます。";
    else if (workspace.busy && !enabled) reason = "フォルダーの操作中です。";
    return { id, menu: definition[1], label: t(definition[2]), paletteLabel: PALETTE_LABELS[id] ? t(PALETTE_LABELS[id]) : `${t(MENU_LABELS[definition[1]])}: ${t(definition[2])}`, shortcut: definition[3], enabled, reason: enabled ? undefined : t(reason), checked: checked(id) };
  }

  /** Recheck every captured target and native revision before executing an offered action. */
  async function run(id: string, override?: ExplorerTarget) {
    if (!command(id, override)?.enabled) return;
    const { session, workspace, target, uiActions, openFile, notify } = latest.current;
    const location = override ?? target ?? workspace.targetFor();
    if (id === "file-new" || id === "folder-new") workspace.beginCreate(location, id === "folder-new");
    else if (id === "file-rename") await workspace.beginRename(location);
    else if (id === "tree-refresh") await workspace.refreshEntries();
    else if (id === "tree-open") await openFile(location.path);
    else if (id === "folder-open") await workspace.pickFolderAndOpen();
    else if (id === "file-save") await session.handleSave();
    else if (id === "file-reload") await session.handleReload();
    else if (id === "file-close" && session.activeRef.current) await session.closeTab(session.activeRef.current);
    else if ((id.startsWith("edit-") && id !== "edit-find") || id === "selection-all") {
      const expected = captured.current;
      if (!expected || !session.registry) return;
      captured.current = null; setContext(null);
      const gen = session.bumpSelectionGen(expected.cursor.documentId);
      try {
        if (id === "selection-all") {
          const next = await session.registry.selectAll(expected);
          session.setSelections((previous) => ({ ...previous, [next.documentId]: { anchor: next.anchor, head: next.head } }));
          session.echoCursor(next.documentId, next.anchor, next.head);
        } else session.mergeSnapshot(await session.registry.editorAction(expected.cursor, id.slice(5) as EditorAction));
        await session.refreshModeCursor(expected.cursor.documentId, gen);
      } catch (cause) { if (cause instanceof StaleResync) session.sayStale(cause.snapshot); else notify(localizedFailure(cause, workspaceErrorText)); }
      finally { restoreEditor.current?.focus(); }
    } else {
      if (id === "palette-open") await prepareEditor(document.activeElement instanceof HTMLElement ? document.activeElement : null);
      uiActions[id]?.();
    }
  }

  // Context state triggers capability updates; the ref is the invocation authority.
  void context;
  return { commands: DEFINITIONS.filter(([id]) => id !== "tree-open").map(([id]) => command(id)!), command, run, prepareEditor };
}
