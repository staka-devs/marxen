import { LocalizedError } from "../../domain/localized-error";
// Tauri isolation transport (infrastructure).
//
// Isolated copy lifecycle pinned by Rust until stream settlement. No React or
// DOM rendering: application owns staging orchestration via ports and the
// composition root injects this transport.

import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  IsolatedCopyId,
  PromptContext,
  PromptMode,
  ProposalText,
} from "../../contracts/ai-contracts";
import type {
  ApproveResult,
  IsolationDiff,
  IsolatedCopyInfo,
  StagedProposal,
} from "../../contracts/isolation-contracts";
import type { IsolationGateway } from "../../application/ports";

/**
 * Require the desktop transport for isolation copies.
 *
 * Throws a localizable error in the browser demo, which never stages.
 */
export function requireDesktop(): void {
  if (!isTauri()) {
    throw new LocalizedError("隔離コピー機能はデスクトップアプリで利用します。");
  }
}

/**
 * Register prompt contexts as an isolated staging copy.
 *
 * Copies stay pinned by Rust until stream settlement; callers pair this with
 * the proposal intake.
 */
export async function createIsolatedCopy(contexts: PromptContext[]): Promise<IsolatedCopyInfo> {
  requireDesktop();
  return invoke<IsolatedCopyInfo>("isolation_create", { contexts });
}

/**
 * Fetch diffs with drift detection for an isolated copy.
 *
 * Drifted entries mean the live buffer moved since the copy and approve will
 * refuse until resync.
 */
export async function fetchIsolationDiff(copyId: IsolatedCopyId): Promise<IsolationDiff[]> {
  requireDesktop();
  return invoke<IsolationDiff[]>("isolation_diff", { copyId });
}

/**
 * Stage a validated text proposal into the copy for review.
 *
 * Flow: chat onProposal -> stage -> ReviewPanel -> approve/reject/cancel.
 * Questions (`ask`) only display and are refused here.
 */
export async function stageProposal(
  copyId: IsolatedCopyId,
  proposal: ProposalText,
  mode: PromptMode,
): Promise<StagedProposal> {
  requireDesktop();
  return invoke<StagedProposal>("isolation_stage_proposal", { copyId, proposal, mode });
}

/**
 * Approve and apply the staged copy with scoped rollback per document.
 *
 * Applied buffers move in Neovim; callers pull fresh snapshots afterwards.
 */
export async function approveIsolatedCopy(copyId: IsolatedCopyId): Promise<ApproveResult> {
  requireDesktop();
  return invoke<ApproveResult>("isolation_approve", { copyId });
}

/**
 * Reject the staged copy without touching Markdown or disk.
 *
 * Clears the single shared staging slot for the next send.
 */
export async function rejectIsolatedCopy(copyId: IsolatedCopyId): Promise<void> {
  requireDesktop();
  await invoke("isolation_reject", { copyId });
}

/**
 * Cancel the copy after runs settle, discarding staged text.
 *
 * Runs settle inside the chat stop before this cleanup discards the copy.
 */
export async function cancelIsolatedCopy(copyId: IsolatedCopyId): Promise<void> {
  requireDesktop();
  await invoke("isolation_cancel", { copyId });
}

/** Isolation gateway adapter satisfying the application port with Tauri IPC. */
export const isolationGateway: IsolationGateway = {
  /** Register contexts as an isolated copy. */
  createCopy: createIsolatedCopy,
  /** Fetch diffs with drift detection for a copy. */
  fetchDiff: fetchIsolationDiff,
  /** Stage a validated proposal into the copy. */
  stageProposal,
  /** Approve and apply the staged copy with scoped rollback. */
  approveCopy: approveIsolatedCopy,
  /** Reject the staged copy without touching disk. */
  rejectCopy: rejectIsolatedCopy,
  /** Cancel the copy after runs settle. */
  cancelCopy: cancelIsolatedCopy,
};

export type { ApproveResult, IsolationDiff, IsolatedCopyInfo, StagedProposal };
