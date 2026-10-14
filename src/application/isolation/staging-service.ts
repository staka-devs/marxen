import type { Translator } from "../../contracts/localization";
import { japaneseTranslator } from "../../domain/localization";
import { localizedMessage, localizedParts, renderLocalizedText } from "../../domain/localization";
import type { LocalizedText, MessageDescriptor } from "../../contracts/localization";
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
import type { ApproveResult, IsolationDiff, StagedImportOutcome } from "../../contracts/isolation-contracts";
import type {
  DocumentSnapshot,
  SaveRequest,
  SaveResult,
} from "../../contracts/contracts";
import type { IsolationGateway } from "../ports";

/** Narrow ports for review apply/save orchestration, bound by the caller. */
export interface ReviewApplyPorts {
  /** Approve and apply the staged copy with scoped rollback. */
  approveCopy(copyId: IsolatedCopyId): Promise<ApproveResult>;
  /** Fetch the authoritative snapshot for an applied document. */
  fetchSnapshot(documentId: string): Promise<DocumentSnapshot>;
  /** Save one document at an exact base revision. */
  saveDocument(request: SaveRequest): Promise<SaveResult>;
}

/** Narrow port for staged new-file import bound to the copy workspace. */
export interface ImportPorts {
  /** Import staged files into the approved copy's original workspace. */
  importNewFiles(
    copyId: IsolatedCopyId,
    files: Array<{ rel: string; content: string }>,
  ): Promise<StagedImportOutcome[]>;
}

/**
 * Bind review ports from their three operations for hook injection.
 *
 * Keeps call sites to anonymous closures so orchestration stays in the
 * shared use case instead of growing presentation hooks.
 */
export function reviewPorts(
  approveCopy: ReviewApplyPorts["approveCopy"],
  fetchSnapshot: ReviewApplyPorts["fetchSnapshot"],
  saveDocument: ReviewApplyPorts["saveDocument"],
): ReviewApplyPorts {
  return { approveCopy, fetchSnapshot, saveDocument };
}

/** Per-document save outcome keyed by the approved revision. */
export interface AppliedSaveOutcome {
  documentId: string;
  saved: boolean;
  error?: string;
}

/** Per-file import outcome with staged content retained for retry. */
export interface ImportOutcome {
  rel: string;
  content: string;
  ok: boolean;
  documentId?: string;
  snapshot?: DocumentSnapshot;
  error?: string;
}

/** Structured result of one apply-and-save orchestration. */
export interface ApplyAndSaveResult {
  approve: ApproveResult;
  /** Authoritative snapshots to merge: post-save on success, pre-save on failure. */
  snapshots: DocumentSnapshot[];
  /** Save outcomes bound to exact approved revisions. */
  saved: AppliedSaveOutcome[];
}

/**
 * Describe an unknown failure without losing backend details or paths.
 *
 * Preserves `Error` messages and backend detail strings verbatim so review
 * surfaces stay actionable.
 */
export function describeSaveFailure(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Approve a staged copy, then save applied documents at exact revisions.
 *
 * Saves bind the exact approved outcome revision, so a user edit interleaved
 * after application fails stale with the user text left dirty instead of
 * saving over it. Snapshot-fetch failures record per-document save failures
 * without attempting a save. Successful saves return the authoritative
 * post-save snapshot for merging, so saved documents show clean; when the
 * post-save fetch itself fails the save is reported as a synchronization
 * failure (keeping the applied text visible) instead of claiming a clean
 * save, and newer user revisions still win the later merge. Throws only when
 * approval itself fails.
 */
export async function approveAndSaveStagedCopy(
  ports: ReviewApplyPorts,
  copyId: IsolatedCopyId,
): Promise<ApplyAndSaveResult> {
  const approve = await ports.approveCopy(copyId);
  const snapshots: DocumentSnapshot[] = [];
  const saved: AppliedSaveOutcome[] = [];
  for (const outcome of approve.outcomes) {
    if (!outcome.applied) continue;
    let preSave: DocumentSnapshot;
    try {
      preSave = await ports.fetchSnapshot(outcome.documentId);
    } catch (cause: unknown) {
      saved.push({ documentId: outcome.documentId, saved: false, error: describeSaveFailure(cause) });
      continue;
    }
    try {
      await ports.saveDocument({ documentId: outcome.documentId, baseRevision: outcome.revision });
    } catch (cause: unknown) {
      snapshots.push(preSave);
      saved.push({ documentId: outcome.documentId, saved: false, error: describeSaveFailure(cause) });
      continue;
    }
    try {
      snapshots.push(await ports.fetchSnapshot(outcome.documentId));
    } catch (cause: unknown) {
      snapshots.push(preSave);
      saved.push({ documentId: outcome.documentId, saved: false, error: describeSaveFailure(cause) });
      continue;
    }
    saved.push({ documentId: outcome.documentId, saved: true });
  }
  return { approve, snapshots, saved };
}

/**
 * Import staged new files into the approved copy's original workspace.
 *
 * Each outcome retains its staged content for retry; existing files stay
 * untouched because creation refuses duplicates. Use the same call for
 * initial import and for retrying only failed entries: approval and document
 * saves never rerun.
 */
export async function importStagedFiles(
  ports: ImportPorts,
  copyId: IsolatedCopyId,
  files: Array<{ rel: string; content: string }>,
): Promise<ImportOutcome[]> {
  const outcomes = await ports.importNewFiles(copyId, files);
  return files.map((file) => {
    const native = outcomes.find((entry) => entry.rel === file.rel);
    if (!native || native.error !== null || native.snapshot === null) {
      return {
        rel: file.rel,
        content: file.content,
        ok: false,
        error: native?.error ?? "import did not return this file",
      };
    }
    return {
      rel: file.rel,
      content: file.content,
      ok: true,
      documentId: native.snapshot.documentId,
      snapshot: native.snapshot,
    };
  });
}

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
  readonlyMessage: string, t: Translator = japaneseTranslator
): Promise<{ copyId: string; registration: StagingRegistration; isNew: boolean }> {
  if (chatOwner !== owner) throw { code: "session_busy" };
  if (!gateway || isReadonly) throw new Error(readonlyMessage);
  if (wanted.length === 0) throw { code: "staging_unresolved", copy_id: t("(未解決)") };
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
  statusMessage: MessageDescriptor;
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
  mode: PromptMode, t: Translator = japaneseTranslator
): Promise<StagedReview> {
  const staged = await gateway.stageProposal(copyId, proposal, mode);
  const fetched = await gateway.fetchDiff(copyId);
  const drifted = fetched.some((diff) => diff.drifted);
  const statusMessage = staged.updated.length > 0
    ? localizedMessage("{{value0}} 文書に取り込みました（{{value1}}文字）。", { value0: staged.updated.length, value1: staged.chars })
    : localizedMessage("取り込みましたが変更はありません。");
  return {
    stagedChars: staged.chars,
    updatedCount: staged.updated.length,
    diffs: fetched,
    drifted,
    status: renderLocalizedText(statusMessage, t),
    statusMessage,
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
  messages: { status: LocalizedText; notice: LocalizedText; reviewMessage: LocalizedText | null };
}

/**
 * Approve a staged copy, pulling fresh snapshots for applied buffers.
 *
 * Returns counts and messages; callers merge snapshots for applied IDs and
 * refresh mode/cursor. Partial application is never presented as
 * all-or-nothing; only error/rollback outcomes fail.
 */
export function summarizeApproveResult(result: ApproveResult, t: Translator = japaneseTranslator): ApproveSummary {
  const failed = result.outcomes.filter(
    (outcome) => outcome.error !== null || outcome.rollbackError !== null || outcome.rolledBack,
  );
  const appliedCount = result.outcomes.filter((outcome) => outcome.applied).length;
  const unchangedCount = result.outcomes.filter(
    (outcome) => !outcome.applied && outcome.error === null && outcome.rollbackError === null && !outcome.rolledBack,
  ).length;
  if (failed.length === 0) {
    const status = unchangedCount > 0 && appliedCount === 0
      ? localizedMessage("変更はありませんでした。")
      : appliedCount > 0 && unchangedCount > 0
        ? localizedMessage("{{value0}} 文書に適用し、{{value1}} 文書は変更なしでした。", { value0: appliedCount, value1: unchangedCount })
        : localizedMessage("承認して適用しました。");
    const notice = localizedMessage("承認して適用しました。");
    return {
      outcomes: result.outcomes,
      appliedCount,
      unchangedCount,
      failedCount: 0,
      status: renderLocalizedText(status, t),
      notice: renderLocalizedText(notice, t),
      reviewMessage: null,
      messages: { status, notice, reviewMessage: null },
    };
  }
  const status = localizedMessage("失敗時は新規コピーで再同期してください。");
  const notice = localizedMessage("一部が未適用です。承認結果を確認してください。");
  const rows = failed.map(outcome => localizedParts(outcome.documentId, outcome.error ? ` (${outcome.error})` : "", outcome.rolledBack ? localizedMessage("（ロールバック済み）") : "", outcome.rollbackError ? localizedMessage("（ロールバック失敗: {{value0}}）", { value0: outcome.rollbackError }) : ""));
  const details = localizedParts(...rows.flatMap((row, index) => index === 0 ? [row] : [", ", row]));
  const reviewMessage = localizedMessage("{{value0}} 文書が未適用です: {{value1}}。", { value0: failed.length, value1: details });
  return {
    outcomes: result.outcomes,
    appliedCount,
    unchangedCount,
    failedCount: failed.length,
    status: renderLocalizedText(status, t),
    notice: renderLocalizedText(notice, t),
    reviewMessage: renderLocalizedText(reviewMessage, t),
    messages: { status, notice, reviewMessage },
  };
}

/**
 * Describe a proposal intake for the review panel without touching disk.
 *
 * Questions display only; non-ask proposals flow through `stageNonAskProposal`.
 * Returns the status text for ask mode.
 */
export function askOnlyStatus(): MessageDescriptor {
  return localizedMessage("質問モードは表示のみです。取り込みは行いません。");
}

/** Per-file save outcome for applied documents in a single apply-and-save action. */
export interface SavedFileOutcome {
  documentId: string;
  saved: boolean;
  error?: string;
}

/** Final status for an apply-and-save run reflecting actual saved/failed files. */
export interface SavedSummary {
  savedCount: number;
  failedCount: number;
  status: LocalizedText;
  notice: LocalizedText;
}

/**
 * Summarize actual saved/failed files after an apply-and-save action.
 *
 * Applied changes retire approval actions; the final status reflects saved
 * versus failed files, never a generic approval message alone.
 */
export function summarizeSavedResult(outcomes: SavedFileOutcome[]): SavedSummary {
  const savedCount = outcomes.filter((outcome) => outcome.saved).length;
  const failedCount = outcomes.filter((outcome) => !outcome.saved).length;
  if (failedCount === 0) {
    return {
      savedCount,
      failedCount: 0,
      status: localizedMessage("保存しました（{{value0}}件）。", { value0: savedCount }),
      notice: localizedMessage("保存しました（{{value0}}件）。", { value0: savedCount }),
    };
  }
  return {
    savedCount,
    failedCount,
    status: localizedMessage("保存に失敗しました（{{value0}}件）。", { value0: failedCount }),
    notice: localizedMessage("保存に失敗しました（{{value0}}件）。", { value0: failedCount }),
  };
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
