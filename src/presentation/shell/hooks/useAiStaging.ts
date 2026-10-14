import { LocalizedError } from "../../../domain/localized-error";
import { localizedFailure, renderLocalizedText } from "../../../domain/localization";
import type { LocalizedText } from "../../../contracts/localization";
import { useI18n } from "../../i18n/I18nProvider";
// AI review and inline flow for the shell (presentation).
//
// Owns the single shared staging slot with mutual exclusion between the
// Agent and inline chats, proposal intake with drift detection, scoped
// approve and rollback, and the inline composer lifecycle. Generation
// fencing, run ownership, and late-handle settlement live in the shared run
// hook and the application staging service; this hook keeps their React
// state and wires them to injected ports, never importing infrastructure.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import type {
  ContextSummary,
  PromptContext,
  PromptMode,
  ProposalText,
} from "../../../contracts/ai-contracts";
import type { ApproveDocOutcome, IsolationDiff } from "../../../contracts/isolation-contracts";
import { resolveInlineTarget } from "../../../domain/conversation/ai-inline-target";
import { describeIsolationError } from "../../../domain/isolation-errors";
import { READONLY_MESSAGE } from "../../../domain/document-errors";
import {
  askOnlyStatus,
  approveAndSaveStagedCopy,
  ensureStagingCopy,
  importStagedFiles,
  reviewPorts,
  stageNonAskProposal,
  summarizeApproveResult,
  summarizeSavedResult,
  toAiProposal,
  type ImportOutcome,
} from "../../../application/isolation/staging-service";
import { docFromOpen } from "../../../application/document/document-helpers";
import type { IsolationGateway } from "../../../application/ports";
import type { DocumentSession } from "./useDocumentSession";

/** Injected ports for AI review and inline flow. */
export interface AiStagingArgs {
  /** True on desktop; the browser demo never stages. */
  desktop: boolean;
  /** Surface a notice without importing shell state. */
  notify: (message: LocalizedText | null) => void;
  /** Document session owning docs, selections, and snapshots. */
  session: DocumentSession;
  /** Isolation staging lifecycle pinned by Rust. */
  isolationGateway?: IsolationGateway;
  /** Refresh file listings after imports register new documents. */
  onWorkspaceChanged?: () => void;
}

/** AI staging state and review operations. */
export interface AiStaging {
  /** Whether the AI scope dismissal is active for the current document. */
  aiDismissed: boolean;
  /** Dismiss or restore the AI scope for the current document. */
  setAiDismissed: React.Dispatch<React.SetStateAction<boolean>>;
  /** Stored proposal awaiting review, if any. */
  aiProposal: { proposal: ProposalText; sent: ContextSummary[]; mode: PromptMode } | null;
  /** Replace the stored proposal (proposal dismissal). */
  setAiProposal: React.Dispatch<
    React.SetStateAction<{ proposal: ProposalText; sent: ContextSummary[]; mode: PromptMode } | null>
  >;
  /** Shared staging slot, or null when nothing is staged. */
  staging: { copyId: string } | null;
  /** Whether the Agent chat owns a run on the shared slot. */
  agentBusy: boolean;
  /** Whether the inline chat owns a run on the shared slot. */
  inlineBusy: boolean;
  /** Broadcast Agent busy ownership, fencing the shared slot. */
  setAgentChatBusy: (busy: boolean) => void;
  /** Broadcast Inline busy ownership, fencing the shared slot. */
  setInlineChatBusy: (busy: boolean) => void;
  /** Whether the inline composer is open. */
  inlineOpen: boolean;
  /** Snapshot backing the inline composer target. */
  inlineSnapshot: PromptContext | null;
  /** Whether the inline target is a selection or a paragraph. */
  inlineKind: "selection" | "paragraph";
  /** Current isolation diffs for review. */
  diffs: IsolationDiff[];
  /** New agent-created Markdown files for import. */
  newFiles: import("../../../contracts/isolation-contracts").StagedNewFile[];
  /** Per-file import outcomes with retained content for retry. */
  importOutcomes: ImportOutcome[];
  /** Whether the last apply-and-save retired approval actions. */
  applied: boolean;
  /** Latest approve outcomes for review. */
  outcomes: ApproveDocOutcome[];
  /** Whether a review operation is in flight. */
  reviewBusy: boolean;
  /** Review error message, if any. */
  reviewMessage: string | null;
  /** Review status text, if any. */
  reviewStatus: string | null;
  /** Exact AI scope at live revision with GUI selection as range. */
  aiContexts: PromptContext[];
  /** Handle a completed AI proposal by staging it for review. */
  handleProposal: (proposal: ProposalText, sent: ContextSummary[], mode: PromptMode) => Promise<void>;
  /** Retry staging the stored proposal preserving exact scope. */
  stageStoredProposal: () => Promise<void>;
  /** Ensure a staging copy for the wanted contexts. */
  ensureStagingFor: (wanted: PromptContext[], owner: "agent" | "inline") => Promise<{ copyId: string }>;
  /** Open inline chat resolving selection or paragraph target. */
  openInlineChat: () => void;
  /** Anchor the inline composer at the caret clamped in view. */
  inlineAnchor: () => { left: number; top: number; bottom: number } | null;
  /** Close inline chat refocusing the editor content. */
  closeInlineChat: () => void;
  /** Fetch review diffs for the staged copy with drift detection. */
  fetchReviewDiff: () => Promise<void>;
  /** Retry failed new-file imports without reapplying document edits. */
  retryImports: () => Promise<void>;
  /** Clear the shared staging slot and its review state. */
  clearStaging: () => void;
  /** Apply and save the staged copy in one natural action, then resync views. */
  approveStaging: () => Promise<void>;
  /** Reject the staged copy without touching disk. */
  rejectStaging: () => Promise<void>;
  /** Cancel the copy after runs settle discarding staged text. */
  cancelStaging: () => Promise<void>;
}

/**
 * Own AI staging: mutual exclusion, proposal intake, review, and inline flow.
 *
 * Returns staging state plus review operations; the shell layout composes
 * them with the Agent panel, inline composer, and review panel.
 */
export function useAiStaging(args: AiStagingArgs): AiStaging {
  const { t, message } = useI18n();
  const { desktop, notify, session, isolationGateway, onWorkspaceChanged } = args;
  const setNotice = notify;
  const {
    registry,
    docsRef,
    activeRef,
    activeId,
    active,
    selections,
    mergeSnapshot,
    refreshModeCursor,
    setDocs,
    setTabs,
  } = session;

  const [aiDismissed, setAiDismissed] = useState(false);
  const [aiProposal, setAiProposal] = useState<{ proposal: ProposalText; sent: ContextSummary[]; mode: PromptMode } | null>(null);
  const [staging, setStaging] = useState<{ copyId: string } | null>(null);
  // Mutual fence for the single shared staging slot: while one chat runs,
  // the other chat's send stays disabled so its owned copy cannot be lost.
  const [agentBusy, setAgentBusy] = useState(false);
  const [inlineBusy, setInlineBusy] = useState(false);
  const chatOwnerRef = useRef<"agent" | "inline" | null>(null);
  /**
   * Broadcast Agent busy ownership, fencing the shared staging slot.
   *
   * First claim wins; release only clears when owned by Agent so Inline's
   * run cannot be fenced by a stale Agent release.
   */
  const setAgentChatBusy = useCallback((busy: boolean) => {
    if (busy && chatOwnerRef.current === null) chatOwnerRef.current = "agent";
    if (!busy && chatOwnerRef.current === "agent") chatOwnerRef.current = null;
    setAgentBusy(busy);
  }, []);
  /**
   * Broadcast Inline busy ownership, fencing the shared staging slot.
   *
   * Mirrors Agent fencing so concurrent staging exclusion holds both ways.
   */
  const setInlineChatBusy = useCallback((busy: boolean) => {
    if (busy && chatOwnerRef.current === null) chatOwnerRef.current = "inline";
    if (!busy && chatOwnerRef.current === "inline") chatOwnerRef.current = null;
    setInlineBusy(busy);
  }, []);
  const [inlineOpen, setInlineOpen] = useState(false);
  const [inlineSnapshot, setInlineSnapshot] = useState<PromptContext | null>(null);
  const [inlineKind, setInlineKind] = useState<"selection" | "paragraph">("selection");
  const [diffs, setDiffs] = useState<IsolationDiff[]>([]);
  const [newFiles, setNewFiles] = useState<import("../../../contracts/isolation-contracts").StagedNewFile[]>([]);
  const [importOutcomes, setImportOutcomes] = useState<ImportOutcome[]>([]);
  const [applied, setApplied] = useState(false);
  const [outcomes, setOutcomes] = useState<ApproveDocOutcome[]>([]);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewMessage, setReviewMessage] = useState<LocalizedText | null>(null);
  const [reviewStatus, setReviewStatus] = useState<LocalizedText | null>(null);

  // Exact AI scope: the active document at its live revision with the GUI
  // selection as the single range. Dismissed per document; questions never
  // edit, and proposals only flow out through onProposal for #8 review.
  /** Exact AI scope at live revision with GUI selection as range. */
  const aiContexts: PromptContext[] = useMemo(() => {
    if (!desktop || !active || aiDismissed) return [];
    const sel = selections[active.documentId] ?? { anchor: 0, head: 0 };
    const collapsed = sel.anchor === sel.head;
    const start = collapsed ? 0 : Math.min(sel.anchor, sel.head, active.text.length);
    const end = collapsed ? active.text.length : Math.min(Math.max(sel.anchor, sel.head), active.text.length);
    return [{ documentId: active.documentId, revision: active.revision, ranges: [{ start, end }], text: active.text.slice(start, end) }];
  }, [desktop, active, selections, aiDismissed]);

  const stagingRef = useRef<string | null>(null);
  stagingRef.current = staging?.copyId ?? null;
  /** Approved copy ID retained for import retry after the slot retires. */
  const appliedCopyRef = useRef<string | null>(null);

  // Shared non-ask intake owned by the application staging service: stage the
  // proposal, report counts, and refresh diffs with drift detection. Callers
  // keep their own busy/error handling because push intake retries diff fetch
  // on failure while manual retry does not. Throws on staging/diff failure.
  /**
   * Stage a non-ask proposal via the application service, updating review state.
   *
   * Delegates to `stageNonAskProposal` with the injected gateway; drifted
   * diffs surface a resync notice. Throws for the caller to report.
   */
  async function stageNonAskCopy(copyId: string, proposal: ProposalText, mode: PromptMode) {
    if (!isolationGateway) throw new LocalizedError(READONLY_MESSAGE);
    const result = await stageNonAskProposal(isolationGateway, copyId, proposal, mode, t);
    setReviewMessage(null);
    setReviewStatus(result.drifted ? message("文書が更新されています。選択範囲を指定し直してください。") : result.statusMessage);
    setDiffs(result.diffs);
    try {
      setNewFiles(await isolationGateway.fetchNewFiles(copyId));
    } catch {
      setNewFiles([]);
    }
    setImportOutcomes([]);
    setApplied(false);
  }

  /**
   * Handle a completed AI proposal by staging it for review.
   *
   * Stores the proposal for manual retry, fetches diffs for ask mode via the
   * injected gateway, and delegates non-ask staging to the application
   * service. Stale runs never reach here (checked in chats).
   */
  const handleProposal = useCallback(
    async (proposal: ProposalText, sent: ContextSummary[], mode: PromptMode) => {
      setAiProposal(toAiProposal(proposal, sent, mode));
      const copyId = stagingRef.current;
      if (!copyId) {
        setNotice(message("AI の提案を受け取りました。差分を確認してください。"));
        return;
      }
      if (mode === "ask") {
        // Questions display only; staging refuses ask.
        setReviewStatus(askOnlyStatus());
        setReviewBusy(true);
        try {
          if (!isolationGateway) throw new LocalizedError(READONLY_MESSAGE);
          const fetched = await isolationGateway.fetchDiff(copyId);
          setDiffs(fetched);
          setNewFiles([]);
          setApplied(false);
          setReviewMessage(null);
        } catch (cause: unknown) {
          setReviewMessage(localizedFailure(cause, describeIsolationError));
        } finally {
          setReviewBusy(false);
        }
        return;
      }
      setReviewBusy(true);
      try {
        await stageNonAskCopy(copyId, proposal, mode);
      } catch (cause: unknown) {
        setReviewMessage(localizedFailure(cause, describeIsolationError));
        try {
          if (!isolationGateway) throw new LocalizedError(READONLY_MESSAGE);
          const fetched = await isolationGateway.fetchDiff(copyId);
          setDiffs(fetched);
        } catch {
          // Diff fetch failure already reported via staging error.
        }
      } finally {
        setReviewBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isolationGateway, notify],
  );

  // Manual retry for the staged-proposal intake (ReviewPanel button).
  // Uses the stored proposal + mode so exact scope is preserved.
  /** Retry staging the stored proposal preserving exact scope. */
  const stageStoredProposal = useCallback(async () => {
    const copyId = stagingRef.current;
    const stored = aiProposal;
    if (!copyId || !stored) return;
    if (stored.mode === "ask") {
      setReviewMessage(message("質問モードは表示のみです。取り込みは行いません。"));
      return;
    }
    setReviewBusy(true);
    try {
      await stageNonAskCopy(copyId, stored.proposal, stored.mode);
    } catch (cause: unknown) {
      setReviewMessage(localizedFailure(cause, describeIsolationError));
    } finally {
      setReviewBusy(false);
    }
  }, [aiProposal]);

  // Register the exact selected snapshot as an isolated staging copy.
  // Sending always pairs this registration with onProposal above.
  // Copies stay pinned by Rust until stream settlement; cancel only touches
  // settled copies, and pin refusals surface as actionable io errors.
  const registeredContextsRef = useRef<PromptContext[]>([]);

  /**
   * Ensure a staging copy for the wanted contexts, reusing only on exact match.
   *
   * Delegates to the application staging service with the injected gateway;
   * the single shared slot fences the other chat via `chatOwnerRef`. Throws
   * `session_busy` or `staging_unresolved` for the chats to report.
   */
  const ensureStagingFor = useCallback(
    async (wanted: PromptContext[], owner: "agent" | "inline"): Promise<{ copyId: string }> => {
      const currentId = stagingRef.current;
      const current = currentId ? { copyId: currentId, contexts: registeredContextsRef.current } : null;
      const result = await ensureStagingCopy(
        isolationGateway,
        current,
        registeredContextsRef.current,
        wanted,
        owner,
        chatOwnerRef.current,
        !registry,
        READONLY_MESSAGE, t);
      stagingRef.current = result.copyId;
      setStaging({ copyId: result.copyId });
      registeredContextsRef.current = result.registration.contexts;
      if (result.isNew) {
        setDiffs([]);
        setNewFiles([]);
        setImportOutcomes([]);
        setApplied(false);
        setOutcomes([]);
        setReviewMessage(null);
        setReviewStatus(message("送信範囲を自動登録しました。"));
      }
      return { copyId: result.copyId };
    },
    [registry, isolationGateway],
  );

  /** Open inline chat resolving selection or paragraph target. */
  const openInlineChat = useCallback(() => {
    if (inlineBusy) { setNotice(message("インラインチャットの応答が終わるか、停止するまでお待ちください。")); return; }
    const doc = activeRef.current ? docsRef.current[activeRef.current] : undefined;
    if (!doc || !registry) {
      setNotice(READONLY_MESSAGE);
      return;
    }
    const sel = selections[doc.documentId] ?? { anchor: 0, head: 0 };
    const target = resolveInlineTarget(doc.text, sel.anchor, sel.head);
    setInlineSnapshot({
      documentId: doc.documentId,
      revision: doc.revision,
      ranges: [{ start: target.start, end: target.end }],
      text: target.excerpt,
    });
    setInlineKind(target.kind);
    setInlineOpen(true);
  }, [registry, selections, inlineBusy, docsRef, activeRef, notify]);

  /** Anchor the inline composer at the caret clamped in view. */
  const inlineAnchor = useCallback(() => {
    const host = document.querySelector<HTMLElement>('[data-testid="editor-primary"] .cm-editor');
    if (!host) return null;
    const box = host.getBoundingClientRect();
    try {
      const view = EditorView.findFromDOM(host);
      const caret = view?.coordsAtPos(view.state.selection.main.head);
      if (caret) return { ...caret, left: Math.min(caret.left, Math.max(box.left + 12, box.right - 396)) };
    } catch { /* Editor may be rebuilding after a view switch. */ }
    return { left: box.left + 24, top: box.top + 24, bottom: box.top + 48 };
  }, []);

  /** Close inline chat refocusing the editor content. */
  const closeInlineChat = useCallback(() => {
    setInlineOpen(false);
    document.querySelector<HTMLElement>('[data-testid="editor-primary"] .cm-content')?.focus();
  }, []);

  useEffect(() => { setInlineOpen(false); }, [activeId]);

  useEffect(() => {
    setAiDismissed(false);
  }, [activeId]);

  /**
   * Fetch review diffs for the staged copy with drift detection.
   *
   * Drifted entries mean the live buffer moved; approve refuses until resync.
   * New agent files refresh alongside diffs for changed-file cards.
   */
  const fetchReviewDiff = useCallback(async () => {
    const copyId = stagingRef.current;
    if (!copyId) return;
    setReviewBusy(true);
    try {
      if (!isolationGateway) throw new LocalizedError(READONLY_MESSAGE);
      const fetched = await isolationGateway.fetchDiff(copyId);
      setDiffs(fetched);
      try {
        setNewFiles(await isolationGateway.fetchNewFiles(copyId));
      } catch {
        setNewFiles([]);
      }
      setReviewMessage(null);
      setReviewStatus(fetched.some((diff) => diff.drifted) ? message("文書が更新されています。選択範囲を指定し直してください。") : null);
    } catch (cause) {
      setReviewMessage(localizedFailure(cause, describeIsolationError));
    } finally {
      setReviewBusy(false);
    }
  }, [isolationGateway]);

  /**
   * Clear the shared staging slot and its review state.
   *
   * Hiding the sidebar preserves transcript/staging (aside stays mounted);
   * this is only called on explicit reject/cancel/approve settlement.
   */
  const clearStaging = useCallback(() => {
    setStaging(null);
    setDiffs([]);
    setNewFiles([]);
    setImportOutcomes([]);
    setApplied(false);
    appliedCopyRef.current = null;
    setOutcomes([]);
    setReviewMessage(null);
    setReviewStatus(null);
  }, []);

  /**
   * Register successfully imported documents into the live session.
   *
   * Merges each returned snapshot into the docs map, adds background tabs,
   * and refreshes file listings so Explorer and tabs reflect the new files.
   * Failures stay in `importOutcomes` with their staged content for retry.
   */
  const registerImports = useCallback((imports: ImportOutcome[]) => {
    let registered = 0;
    for (const item of imports) {
      if (!item.ok || !item.snapshot) continue;
      if (registry) registry.noteSnapshot(item.snapshot);
      const doc = docFromOpen({ path: item.rel, snapshot: item.snapshot });
      setDocs((prev) => ({ ...prev, [doc.documentId]: doc }));
      setTabs((prev) => (prev.includes(doc.documentId) ? prev : [...prev, doc.documentId]));
      registered += 1;
    }
    if (registered > 0) onWorkspaceChanged?.();
  }, [registry, setDocs, setTabs, onWorkspaceChanged]);

  /**
   * Apply and save the staged copy in one natural action, then resync views.
   *
   * Delegates approval and exact-revision saves to the application use case
   * and imports staged files through the native workspace-bound command; this
   * hook only merges snapshots, registers imported documents, and reports.
   * Applied changes retire approval actions; partial and new-only import
   * failures report as failures with a retry that never reapplies edits.
   */
  const approveStaging = useCallback(async () => {
    const copyId = stagingRef.current;
    if (!copyId) return;
    if (diffs.some((diff) => diff.drifted)) {
      setReviewMessage(message("文書が更新されています。選択範囲を指定し直してください。"));
      return;
    }
    setReviewBusy(true);
    try {
      if (!isolationGateway || !registry) throw new LocalizedError(READONLY_MESSAGE);
      const applied = await approveAndSaveStagedCopy(
        reviewPorts(
          (id) => isolationGateway.approveCopy(id),
          (documentId) => registry.fetchSnapshot(documentId),
          (request) => registry.save(request),
        ),
        copyId,
      );
      for (const snapshot of applied.snapshots) mergeSnapshot(snapshot);
      if (activeRef.current) await refreshModeCursor(activeRef.current);
      const imports = newFiles.length > 0
        ? await importStagedFiles(isolationGateway, copyId, newFiles)
        : [];
      registerImports(imports);
      const summary = summarizeApproveResult(applied.approve, t);
      const saved = summarizeSavedResult(applied.saved);
      const failedImports = imports.filter((item) => !item.ok);
      setOutcomes(summary.outcomes);
      setImportOutcomes(imports);
      setStaging(null);
      appliedCopyRef.current = copyId;
      setApplied(true);
      setAiProposal(null);
      if (summary.failedCount > 0) {
        setReviewMessage(summary.messages.reviewMessage);
        setReviewStatus(summary.messages.status);
        setNotice(summary.messages.notice);
      } else if (saved.failedCount > 0 || failedImports.length > 0) {
        const failed = message("保存に失敗しました（{{value0}}件）。", { value0: saved.failedCount + failedImports.length });
        setReviewMessage(failed);
        setReviewStatus(failed);
        setNotice(failed);
      } else {
        const total = applied.saved.filter((entry) => entry.saved).length
          + imports.filter((item) => item.ok).length;
        const doneMessage = total > 0
          ? message("保存しました（{{value0}}件）。", { value0: total })
          : summary.messages.status;
        setReviewMessage(null);
        setReviewStatus(doneMessage);
        setNotice(doneMessage);
      }
      try {
        if (activeRef.current) await refreshModeCursor(activeRef.current);
      } catch {
        // Best-effort cursor refresh after save.
      }
    } catch (cause) {
      setReviewMessage(localizedFailure(cause, describeIsolationError));
      setReviewStatus(message("再同期して範囲を再登録してください。"));
    } finally {
      setReviewBusy(false);
    }
  }, [diffs, newFiles, registry, mergeSnapshot, refreshModeCursor, registerImports, isolationGateway, activeRef, notify]);

  /**
   * Retry failed new-file imports without reapplying document edits.
   *
   * Reruns only creation for entries still failing with their retained
   * staged content; approval and document saves never rerun, so already
   * applied edits stay exactly as saved.
   */
  const retryImports = useCallback(async () => {
    const copyId = appliedCopyRef.current;
    const failed = importOutcomes.filter((item) => !item.ok);
    if (!copyId || failed.length === 0 || !isolationGateway) return;
    setReviewBusy(true);
    try {
      // Retry binds the same approved copy workspace; only failed creations
      // rerun with their retained content.
      const retried = await importStagedFiles(isolationGateway, copyId, failed);
      const merged = importOutcomes.map((item) => retried.find((next) => next.rel === item.rel) ?? item);
      setImportOutcomes(merged);
      registerImports(retried);
      const remaining = merged.filter((item) => !item.ok).length;
      if (remaining > 0) {
        const failedMessage = message("保存に失敗しました（{{value0}}件）。", { value0: remaining });
        setReviewMessage(failedMessage);
        setReviewStatus(failedMessage);
        setNotice(failedMessage);
      } else {
        const doneMessage = message("保存しました（{{value0}}件）。", { value0: merged.length });
        setReviewMessage(null);
        setReviewStatus(doneMessage);
        setNotice(doneMessage);
      }
    } catch (cause) {
      setReviewMessage(localizedFailure(cause, describeIsolationError));
    } finally {
      setReviewBusy(false);
    }
  }, [importOutcomes, isolationGateway, registerImports, notify]);

  /** Reject the staged copy without touching disk. */
  const rejectStaging = useCallback(async () => {
    const copyId = stagingRef.current;
    if (!copyId) return;
    setReviewBusy(true);
    try {
      await isolationGateway!.rejectCopy(copyId);
      clearStaging();
      setAiProposal(null);
      setNotice(message("提案を却下しました。Markdownとディスクは変更していません。"));
    } catch (cause) {
      setReviewMessage(localizedFailure(cause, describeIsolationError));
    } finally {
      setReviewBusy(false);
    }
  }, [clearStaging, isolationGateway, notify]);

  // Runs settle inside AiPanel.stop before this cleanup discards the copy.
  /** Cancel the copy after runs settle discarding staged text. */
  const cancelStaging = useCallback(async () => {
    const copyId = stagingRef.current;
    if (!copyId) return;
    setReviewBusy(true);
    try {
      await isolationGateway!.cancelCopy(copyId);
      clearStaging();
      setAiProposal(null);
      setNotice(message("取り消しました。Markdownとディスクは変更していません。"));
    } catch (cause) {
      setReviewMessage(localizedFailure(cause, describeIsolationError));
    } finally {
      setReviewBusy(false);
    }
  }, [clearStaging, isolationGateway, notify]);

  return {
    aiDismissed,
    setAiDismissed,
    aiProposal,
    setAiProposal,
    staging,
    agentBusy,
    inlineBusy,
    setAgentChatBusy,
    setInlineChatBusy,
    inlineOpen,
    inlineSnapshot,
    inlineKind,
    diffs,
    newFiles,
    importOutcomes,
    applied,
    outcomes,
    reviewBusy,
    reviewMessage: reviewMessage === null ? null : renderLocalizedText(reviewMessage, t),
    reviewStatus: reviewStatus === null ? null : renderLocalizedText(reviewStatus, t),
    aiContexts,
    handleProposal,
    stageStoredProposal,
    ensureStagingFor,
    openInlineChat,
    inlineAnchor,
    closeInlineChat,
    fetchReviewDiff,
    retryImports,
    clearStaging,
    approveStaging,
    rejectStaging,
    cancelStaging,
  };
}

/** Return type of the AI staging hook for shell composition. */
export type AiStagingHandle = ReturnType<typeof useAiStaging>;

