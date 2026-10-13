import { Button } from "./ui/button";
import { Card } from "./ui/card";
import type { ApproveDocOutcome, IsolationDiff } from "../shared/isolation-contracts";

/** Props owned by Issue #8. UI (#5) mounts this next to AiPanel and wires
 *  the callbacks to `src/lib/isolation.ts` (or its own handlers).
 *  Full flow: AiPanel onProposal -> stageProposal -> ReviewPanel
 *  (fetch diff, approve, reject, cancel). AiPanel itself is owned by UI. */
export interface ReviewPanelProps {
  copyId: string | null;
  diffs: IsolationDiff[];
  outcomes: ApproveDocOutcome[];
  busy: boolean;
  message: string | null;
  status: string | null;
  proposalText: string | null;
  onFetchDiff: () => void;
  onStageProposal: (() => void) | null;
  onApprove: () => void;
  onReject: () => void;
  onCancel: () => void;
}

export default function ReviewPanel({
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
}: ReviewPanelProps) {
  return (
    <Card aria-labelledby="review-panel-title">
      <h2 id="review-panel-title" className="text-base font-semibold">差分レビュー (隔離コピー)</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Markdownへの反映は承認した範囲パッチのみを Neovim 経由で行います。却下・取消はMarkdownとディスクを変更しません。隔離はコピーであり OS サンドボックスではありません。
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        作業コピー: {copyId ? <span className="font-mono">{copyId}</span> : "未作成"}
      </p>
      {proposalText !== null && onStageProposal !== null && (
        <div className="mt-2 rounded-lg border border-border p-2">
          <p className="text-xs font-semibold text-muted-foreground">取り込み待ちの提案</p>
          <p className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-xs">{proposalText}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={onStageProposal} disabled={!copyId || busy}>
            提案を作業コピーに取り込む
          </Button>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={onFetchDiff} disabled={!copyId || busy}>
          差分を確認
        </Button>
        <Button size="sm" onClick={onApprove} disabled={!copyId || busy}>
          承認して適用
        </Button>
        <Button variant="outline" size="sm" onClick={onReject} disabled={!copyId || busy}>
          却下
        </Button>
        <Button variant="outline" size="sm" onClick={onCancel} disabled={!copyId || busy}>
          取消
        </Button>
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
        <ul className="mt-2 space-y-1" aria-label="承認結果">
          {outcomes.map((outcome) => {
            const failed = outcome.error !== null || outcome.rollbackError !== null || outcome.rolledBack;
            const unchanged = !outcome.applied && !failed;
            return (
              <li key={outcome.documentId} className="font-mono text-xs">
                {outcome.documentId} rev {outcome.revision}{" "}
                {outcome.applied ? "適用" : unchanged ? "変更なし" : "未適用"}
                {outcome.rolledBack ? " (ロールバック済み)" : ""}
                {outcome.error ? ` 失敗: ${outcome.error}` : ""}
                {outcome.rollbackError ? ` ロールバック失敗: ${outcome.rollbackError}` : ""}
              </li>
            );
          })}
        </ul>
      )}
      {diffs.length > 0 && (
        <ul className="mt-2 space-y-2">
          {diffs.map((diff, index) => (
            <li key={`${diff.documentId}-${index}`} className="rounded-lg border border-border p-2">
              <p className="font-mono text-xs">
                {diff.documentId} [{diff.range.start}, {diff.range.end}) rev {diff.baseRevision} → {diff.liveRevision}
                {diff.drifted ? " (外部変更あり・要再同期)" : ""} {diff.changed ? "変更あり" : "変更なし"}
              </p>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-xs">{diff.unified}</pre>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
