// Isolated staging use cases for AI proposals (application).
//
// Owns the single shared staging slot, generation fencing, run ownership, and
// cleanup for agent/inline chats. Pure async functions with explicit ports:
// no React, Tauri, DOM, or browser globals. Presentation owns React state and
// calls these with injected gateways, keeping busy ownership in the shell.

import type {
  ContextSummary,
  PromptContext,
  PromptMode,
  ProposalText,
  IsolatedCopyId,
} from "../../contracts/ai-contracts";
import type { ApproveResult, IsolationDiff } from "../../contracts/isolation-contracts";
import type { IsolationGateway } from "../ports";

/** Registered staging state pinned by Rust until stream settlement. */
export interface StagingRegistration {
  copyId: IsolatedCopyId;
  contexts: PromptContext[];
}

/**
 * Ensure a staging copy for the wanted contexts, reusing only on exact match.
 *
 * Throws `session_busy` when another chat owns the slot, `staging_unresolved`
 * for empty scopes, or read-only errors without a gateway. Cancels the
 * previous copy before registering a new one so only one copy stays pinned.
 * Copies stay pinned until stream settlement; cancel only touches settled
 * copies.
 */
export async function ensureStagingCopy(
  gateway: IsolationGateway | undefined,
  current: StagingRegistration | null,
  registered: PromptContext[],
  wanted: PromptContext[],
  owner: "agent" | "inline",
  chatOwner: "agent" | "inline" | null,
  isReadonly: boolean,
  readonlyMessage: string,
): Promise<{ copyId: string; registration: StagingRegistration; isNew: boolean }> {
  if (chatOwner !== owner) throw { code: "session_busy" };
  if (!gateway || isReadonly) throw new Error(readonlyMessage);
  if (wanted.length === 0) throw { code: "staging_unresolved", copy_id: "(未解決)" };
  const same = current !== null && contextsEqualShallow(registered, wanted);
  if (same && current) return { copyId: current.copyId, registration: current, isNew: false };
  if (current) await gateway.cancelCopy(current.copyId).catch(() => undefined);
  const info = await gateway.createCopy(wanted);
  const registration: StagingRegistration = {
    copyId: info.copyId,
    contexts: wanted.map((context) => ({ ...context })),
  };
  return { copyId: info.copyId, registration, isNew: true };
}

/**
 * Compare two context lists for exact scope equality.
 *
 * Compares IDs, revisions, full text, and every range so staging reuses only
 * on exact match.
 */
export function contextsEqualShallow(left: PromptContext[], right: PromptContext[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((context, index) => {
    const other = right[index];
    return (
      context.documentId === other.documentId &&
      context.revision === other.revision &&
      context.text === other.text &&
      context.ranges.length === other.ranges.length &&
      context.ranges.every((range, rangeIndex) => {
        const o = other.ranges[rangeIndex];
        return range.start === o.start && range.end === o.end;
      })
    );
  });
}

/** Result of staging a non-ask proposal with refreshed diffs. */
export interface StagedReview {
  stagedChars: number;
  updatedCount: number;
  diffs: IsolationDiff[];
  drifted: boolean;
  status: string;
}

/**
 * Stage a non-ask proposal and refresh diffs with drift detection.
 *
 * Throws on staging/diff failure for the caller to report; questions (`ask`)
 * are refused by the transport and never reach here.
 */
export async function stageNonAskProposal(
  gateway: IsolationGateway,
  copyId: string,
  proposal: ProposalText,
  mode: PromptMode,
): Promise<StagedReview> {
  const staged = await gateway.stageProposal(copyId, proposal, mode);
  const fetched = await gateway.fetchDiff(copyId);
  const drifted = fetched.some((diff) => diff.drifted);
  return {
    stagedChars: staged.chars,
    updatedCount: staged.updated.length,
    diffs: fetched,
    drifted,
    status: staged.updated.length > 0
      ? `${staged.updated.length} 文書に取り込みました（${staged.chars}文字）。`
      : "取り込みましたが変更はありません。",
  };
}

/** Outcome summary for an approve run with scoped rollback. */
export interface ApproveSummary {
  outcomes: ApproveResult["outcomes"];
  appliedCount: number;
  unchangedCount: number;
  failedCount: number;
  status: string;
  notice: string;
  reviewMessage: string | null;
}

/**
 * Approve a staged copy, pulling fresh snapshots for applied buffers.
 *
 * Returns counts and messages; callers merge snapshots for applied IDs and
 * refresh mode/cursor. Partial application is never presented as
 * all-or-nothing; only error/rollback outcomes fail.
 */
export function summarizeApproveResult(result: ApproveResult): ApproveSummary {
  const failed = result.outcomes.filter(
    (outcome) => outcome.error !== null || outcome.rollbackError !== null || outcome.rolledBack,
  );
  const appliedCount = result.outcomes.filter((outcome) => outcome.applied).length;
  const unchangedCount = result.outcomes.filter(
    (outcome) => !outcome.applied && outcome.error === null && outcome.rollbackError === null && !outcome.rolledBack,
  ).length;
  if (failed.length === 0) {
    return {
      outcomes: result.outcomes,
      appliedCount,
      unchangedCount,
      failedCount: 0,
      status: unchangedCount > 0 && appliedCount === 0
        ? "変更はありませんでした。"
        : appliedCount > 0 && unchangedCount > 0
          ? `${appliedCount} 文書に適用し、${unchangedCount} 文書は変更なしでした。`
          : "承認して適用しました。",
      notice: "承認して適用しました。保存は保存ボタンで行います。",
      reviewMessage: null,
    };
  }
  return {
    outcomes: result.outcomes,
    appliedCount,
    unchangedCount,
    failedCount: failed.length,
    status: "失敗時は新規コピーで再同期してください。",
    notice: "一部が未適用です。承認結果を確認してください。",
    reviewMessage: `${failed.length} 文書が未適用です: ${failed.map((outcome) => `${outcome.documentId}${outcome.error ? ` (${outcome.error})` : ""}${outcome.rolledBack ? "（ロールバック済み）" : ""}${outcome.rollbackError ? `（ロールバック失敗: ${outcome.rollbackError}）` : ""}`).join(", ")}。`,
  };
}

/**
 * Describe a proposal intake for the review panel without touching disk.
 *
 * Questions display only; non-ask proposals flow through `stageNonAskProposal`.
 * Returns the status text for ask mode.
 */
export function askOnlyStatus(): string {
  return "質問モードは表示のみです。取り込みは行いません。";
}

/**
 * Build the AI proposal record for shell state from a completed run.
 *
 * Pure adapter keeping transcript and staging in sync without side effects.
 */
export function toAiProposal(proposal: ProposalText, sent: ContextSummary[], mode: PromptMode): {
  proposal: ProposalText;
  sent: ContextSummary[];
  mode: PromptMode;
} {
  return { proposal, sent, mode };
}
