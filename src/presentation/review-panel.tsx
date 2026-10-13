import { useI18n } from "./i18n/I18nProvider";
import { Button } from "./ui/button";
import { Check, ChevronDown } from "lucide-react";
import type { ApproveDocOutcome, IsolationDiff } from "../contracts/isolation-contracts";

/**
 * Props owned by Issue #8. UI mounts this next to AiPanel and wires callbacks
 * through the composition root. Full flow: AiPanel onProposal -> stage ->
 * ReviewPanel (fetch diff, approve, reject, cancel).
 */
export interface ReviewPanelProps {
  copyId: string | null;
  diffs: IsolationDiff[];
  outcomes: ApproveDocOutcome[];
  busy: boolean;
  message: string | null;
  status: string | null;
  proposalText: string | null;
  /** Refetch diffs for the staged copy. */
  onFetchDiff: () => void;
  onStageProposal: (() => void) | null;
  /** Approve the staged copy, then resync views. */
  onApprove: () => void;
  /** Reject the staged copy without touching disk. */
  onReject: () => void;
  /** Cancel the copy after runs settle. */
  onCancel: () => void;
  documentLabels?: Record<string, string>;
}

/** Render the isolation review panel with diffs and approve controls. */ export default function ReviewPanel({
  copyId,
  diffs,
  outcomes,
  busy,
  message,
  status,
  proposalText,
  onFetchDiff,
  onStageProposal,
  onApprove,
  onReject,
  onCancel,
  documentLabels,
}: ReviewPanelProps) {
  const { t } = useI18n();
  /** Map a document ID to its visible label without internal IDs. */ const label = (documentId: string) => documentLabels ? documentLabels[documentId] ?? t("文書") : documentId;
  if (!diffs.some((diff) => diff.changed) && outcomes.length === 0 && !message && !onStageProposal) {
    return null;
  }
  const completed = !copyId && !onStageProposal && !message && outcomes.length > 0;
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
    <section aria-labelledby="review-panel-title" className="border-t border-border px-3 py-3">
      <h2 id="review-panel-title" className="text-xs font-semibold">{t("変更の確認")}</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("適用すると編集中の文書が更新されます。ファイルの保存は別操作です。")}</p>
      {proposalText !== null && onStageProposal !== null && (
        <div className="mt-2 rounded-sm border border-border p-2">
          <p className="text-xs font-semibold text-muted-foreground">{t("取り込み待ちの提案")}</p>
          <p className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-xs">{proposalText}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={onStageProposal} disabled={!copyId || busy}>
            {t("提案を作業コピーに取り込む")}</Button>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button variant="outline" size="sm" onClick={onFetchDiff} disabled={!copyId || busy}>
          {t("差分を確認")}</Button>
        <Button size="sm" onClick={onApprove} disabled={!copyId || busy}>
          {t("承認して適用")}</Button>
        <Button variant="outline" size="sm" onClick={onReject} disabled={!copyId || busy}>
          {t("却下")}</Button>
        <Button variant="outline" size="sm" onClick={onCancel} disabled={!copyId || busy}>
          {t("取消")}</Button>
      </div>
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
              <li key={outcome.documentId} className="font-mono text-xs">
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
      {diffs.length > 0 && (
        <ul className="mt-2 space-y-2">
          {diffs.map((diff, index) => (
            <li key={`${diff.documentId}-${index}`} className="rounded-sm border border-border p-2">
              <p className="font-mono text-xs">
                {label(diff.documentId)}
                {diff.drifted ? t(" (外部変更あり・要再同期)") : ""} {diff.changed ? t("変更あり") : t("変更なし")}
              </p>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-xs">{diff.unified}</pre>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

