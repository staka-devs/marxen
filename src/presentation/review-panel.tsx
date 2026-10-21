import { useI18n } from "./i18n/I18nProvider";
import { Button } from "./ui/button";
import { Check, ChevronDown } from "lucide-react";
import type { ApproveDocOutcome, IsolationDiff, StagedNewFile } from "../contracts/isolation-contracts";
import { ChangedFileList } from "./ai/agent-cards";

/**
 * Props owned by Issue #69 (agentic review). UI mounts this next to AiPanel
 * and wires callbacks through the composition root. Full flow: AiPanel
 * onProposal -> stage -> ReviewPanel (fetch diff, apply-and-save, reject,
 * cancel). Applied changes retire approval actions; the final status reflects
 * actual saved/failed files. No internal mechanics paragraph or raw
 * live/staging identifiers appear in product text.
 */
export interface ReviewPanelProps {
  copyId: string | null;
  diffs: IsolationDiff[];
  /** New agent-created Markdown files for import in one action. */
  newFiles?: StagedNewFile[];
  /** Per-file import outcomes with retained errors for retry. */
  importOutcomes?: Array<{ rel: string; ok: boolean; error?: string }>;
  /** True after apply-and-save retired approval actions. */
  applied?: boolean;
  outcomes: ApproveDocOutcome[];
  busy: boolean;
  message: string | null;
  status: string | null;
  proposalText: string | null;
  onStageProposal: (() => void) | null;
  /** Apply and save the staged copy in one natural action. */
  onApprove: () => void;
  /** Discard the staged copy without touching the document or disk. */
  onReject: () => void;
  /** Retry failed new-file imports without reapplying document edits. */
  onRetryImports?: (() => void) | null;
  documentLabels?: Record<string, string>;
}

/** Render the agentic review panel with changed-file cards and single save. */
export default function ReviewPanel({
  copyId,
  diffs,
  newFiles = [],
  importOutcomes = [],
  applied = false,
  outcomes,
  busy,
  message,
  status,
  proposalText,
  onStageProposal,
  onApprove,
  onReject,
  onRetryImports,
  documentLabels,
}: ReviewPanelProps) {
  const { t } = useI18n();
  /** Map a document ID to its visible label without internal IDs. */
  const label = (documentId: string) => documentLabels ? documentLabels[documentId] ?? t("文書") : documentId;
  const failedImports = importOutcomes.filter((item) => !item.ok);
  const changedCount = diffs.filter((diff) => diff.changed).length + newFiles.length;
  const hasChanges = changedCount > 0;
  if (!hasChanges && outcomes.length === 0 && failedImports.length === 0 && !message && !onStageProposal) {
    return null;
  }
  const completed = ((!copyId && !onStageProposal && !message && outcomes.length > 0) || applied) && failedImports.length === 0;
  const allApplied = outcomes.every((outcome) => !outcome.error && !outcome.rollbackError && !outcome.rolledBack);
  if (completed && allApplied) {
    return <section aria-label={t("変更の確認")} className="border-t border-border px-3 py-2 text-xs">
      <details>
        <summary className="flex cursor-pointer list-none items-center gap-2 text-muted-foreground">
          <Check size={14} className="text-primary" aria-hidden="true" />
          <span role="status" className="min-w-0 flex-1">{status ?? t("変更を適用しました。")}</span>
          <ChevronDown size={13} aria-hidden="true" />
        </summary>
        <ul className="mt-2 space-y-1" aria-label={t("承認結果")}>{outcomes.map((outcome) => <li key={outcome.documentId}>{label(outcome.documentId)} {outcome.applied ? t("適用") : t("変更なし")}</li>)}</ul>
      </details>
    </section>;
  }
  return (
    <section aria-labelledby="review-panel-title" className="ai-review-bar border-t border-border px-2 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <h2 id="review-panel-title" className="min-w-0 flex-1 truncate text-xs font-semibold">
          {t("変更の確認")}
          {hasChanges && <span className="ml-1.5 font-normal text-muted-foreground">{t("{{count}} 件のファイル", { count: changedCount })}</span>}
        </h2>
        {!applied && (<>
          <Button size="sm" onClick={onApprove} disabled={!copyId || busy || !hasChanges}>
            {t("適用して保存")}</Button>
          <Button variant="outline" size="sm" onClick={onReject} disabled={!copyId || busy}>
            {t("破棄")}</Button>
        </>)}
      </div>
      {proposalText !== null && onStageProposal !== null && !applied && (
        <Button variant="outline" size="sm" className="mt-2" onClick={onStageProposal} disabled={!copyId || busy}>
          {t("提案を作業コピーに取り込む")}</Button>
      )}
      {message && (
        <p role="alert" className="mt-2 text-sm font-medium text-red-600">
          {message}
        </p>
      )}
      {status && (
        <p role="status" className="mt-2 text-sm font-medium">
          {status}
        </p>
      )}
      {outcomes.length > 0 && (
        <ul className="mt-2 space-y-1" aria-label={t("承認結果")}>
          {outcomes.map((outcome) => {
            const failed = outcome.error !== null || outcome.rollbackError !== null || outcome.rolledBack;
            const unchanged = !outcome.applied && !failed;
            return (
              <li key={outcome.documentId} className="text-xs">
                {label(outcome.documentId)}{" "}
                {outcome.applied ? t("適用") : unchanged ? t("変更なし") : t("未適用")}
                {outcome.rolledBack ? t(" (ロールバック済み)") : ""}
                {outcome.error ? t(" 失敗: {{value0}}", { value0: (outcome.error) }) : ""}
                {outcome.rollbackError ? t(" ロールバック失敗: {{value0}}", { value0: (outcome.rollbackError) }) : ""}
              </li>
            );
          })}
        </ul>
      )}
      <ChangedFileList diffs={diffs} newFiles={newFiles} documentLabels={documentLabels} />
      {failedImports.length > 0 && (
        <div className="mt-2 rounded-sm border border-border p-2">
          <ul className="space-y-1" aria-label={t("取込結果")}>
            {importOutcomes.map((item) => (
              <li key={item.rel} data-testid={`import-file-${item.rel}`} className="text-xs">
                {item.rel}{" "}
                {item.ok ? t("適用") : t("未適用")}
                {!item.ok && item.error ? t(" 失敗: {{value0}}", { value0: (item.error) }) : ""}
              </li>
            ))}
          </ul>
          {onRetryImports && (
            <Button variant="outline" size="sm" className="mt-2" onClick={onRetryImports} disabled={busy}>
              {t("再試行")}</Button>
          )}
        </div>
      )}
    </section>
  );
}
