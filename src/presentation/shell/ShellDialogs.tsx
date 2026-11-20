import { useI18n } from "../i18n/I18nProvider";
import type { ThemeId } from "../../domain/workspace-content";
import { WorkspaceDialog } from "../workspace/Notifications";
import type { WorkspaceHandle } from "./hooks/useWorkspace";
import type { DocumentSessionHandle } from "./hooks/useDocumentSession";

/** Owners of the shell's modal decisions. */
export interface ShellDialogsProps {
  theme: ThemeId;
  workspace: WorkspaceHandle;
  session: DocumentSessionHandle;
  /** Crash-recovery prompt visibility, owned by the shell. */
  recoveryOpen: boolean;
  /** Dismiss the recovery prompt until the next recovery change. */
  onRecoveryClose: () => void;
  /** True while the active document shows an external-change conflict. */
  isConflicted: boolean;
}

/**
 * Recovery, root removal, close, create and rename dialogs.
 *
 * Each dialog reads and resolves through the workspace or document session
 * hooks; this component only renders them (Issue #129).
 */
export function ShellDialogs({ theme, workspace, session, recoveryOpen, onRecoveryClose, isConflicted }: ShellDialogsProps) {
  const { t } = useI18n();
  return (
    <>
    {recoveryOpen && workspace.recovery.length > 0 && !session.closeDecision && !isConflicted && !workspace.newFileOpen && !workspace.renameDoc && (
      <WorkspaceDialog theme={theme} label={t("未保存の文書を復元")} testId="recovery-dialog" onDismiss={() => onRecoveryClose()}>
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
        <div className="mt-4 flex justify-end"><button type="button" onClick={() => onRecoveryClose()} className="rounded-md border border-border px-3 py-1">{t("後で")}</button></div>
      </WorkspaceDialog>
    )}
    {workspace.removingRoot && (
      <WorkspaceDialog theme={theme} label={t("フォルダーをワークスペースから取り除く")} testId="remove-root-dialog" onDismiss={() => { if (!workspace.busy) void workspace.resolveRemoveRoot("cancel"); }}>
        <p className="mb-2 break-all">{workspace.removingRoot.root}</p>
        <p className="mb-2">{t("このフォルダーのタブを閉じます。未保存の変更をどうしますか。")}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={workspace.busy} onClick={() => void workspace.resolveRemoveRoot("save")} className="rounded-md border border-border px-3 py-1">{t("保存して閉じる")}</button>
          <button type="button" disabled={workspace.busy} onClick={() => void workspace.resolveRemoveRoot("discard")} className="rounded-md border border-border px-3 py-1">{t("破棄して閉じる")}</button>
          <button type="button" disabled={workspace.busy} onClick={() => void workspace.resolveRemoveRoot("cancel")} className="rounded-md border border-border px-3 py-1">{t("キャンセル")}</button>
        </div>
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
      <WorkspaceDialog theme={theme} label={t(workspace.entryKind === "folder" ? "新規フォルダー" : workspace.entryKind === "bundle" ? "新規バンドルノート" : "新規Markdownファイル")} onDismiss={() => workspace.setNewFileOpen(false)}>
        <form onSubmit={(event) => { event.preventDefault(); void workspace.createFile(); }} className="flex flex-wrap items-center gap-2">
        <input
          value={workspace.newFilePath}
          onChange={(event) => workspace.setNewFilePath(event.target.value)}
          placeholder={workspace.entryKind === "folder" ? t("メモ/新しいフォルダー") : workspace.entryKind === "bundle" ? "notes/new.marxen" : "notes/new.md"}
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
    </>
  );
}
