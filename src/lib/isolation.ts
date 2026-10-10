import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  IsolatedCopyId,
  PromptContext,
  PromptMode,
  ProposalText,
} from "../shared/ai-contracts";
import type {
  ApproveResult,
  IsolationDiff,
  IsolatedCopyInfo,
  StagedProposal,
} from "../shared/isolation-contracts";

export function requireDesktop(): void {
  if (!isTauri()) {
    throw new Error("隔離コピー機能はデスクトップアプリで利用します。");
  }
}

export async function createIsolatedCopy(contexts: PromptContext[]): Promise<IsolatedCopyInfo> {
  requireDesktop();
  return invoke<IsolatedCopyInfo>("isolation_create", { contexts });
}

export async function fetchIsolationDiff(copyId: IsolatedCopyId): Promise<IsolationDiff[]> {
  requireDesktop();
  return invoke<IsolationDiff[]>("isolation_diff", { copyId });
}

/** Stage a validated text proposal into the copy.
 *  Flow: AiPanel onProposal -> stageProposal -> ReviewPanel -> approve/reject/cancel.
 *  Questions (ask) only display and are refused here. */
export async function stageProposal(
  copyId: IsolatedCopyId,
  proposal: ProposalText,
  mode: PromptMode,
): Promise<StagedProposal> {
  requireDesktop();
  return invoke<StagedProposal>("isolation_stage_proposal", { copyId, proposal, mode });
}

export async function approveIsolatedCopy(copyId: IsolatedCopyId): Promise<ApproveResult> {
  requireDesktop();
  return invoke<ApproveResult>("isolation_approve", { copyId });
}

export async function rejectIsolatedCopy(copyId: IsolatedCopyId): Promise<void> {
  requireDesktop();
  await invoke("isolation_reject", { copyId });
}

export async function cancelIsolatedCopy(copyId: IsolatedCopyId): Promise<void> {
  requireDesktop();
  await invoke("isolation_cancel", { copyId });
}

export type { ApproveResult, IsolationDiff, IsolatedCopyInfo, StagedProposal };

export function describeWorkspaceError(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const record = cause as { code: string; detail?: string; path?: string };
    switch (record.code) {
      case "conflict":
        return `保存競合を検出しました (${record.path ?? "不明"})。最新のMarkdownに再同期してから承認してください。`;
      case "stale_revision":
        return "リビジョンが古いため拒否しました。再同期してください。";
      case "outside_workspace":
        return "作業コピーの外を指しているため拒否しました。";
      case "not_found":
        return "隔離コピーが見つかりません。再作成してください。";
      case "invalid_path":
        return "隔離コピーは利用できません。再作成してください。";
      case "not_markdown":
        return "Markdown 以外は隔離の対象外です。";
      case "io":
        return record.detail ?? "操作に失敗しました。";
      case "neovim":
        return `Neovim との通信に失敗しました: ${record.detail ?? ""}`;
      default:
        return `操作に失敗しました (${record.code})。`;
    }
  }
  return cause instanceof Error ? cause.message : String(cause);
}
