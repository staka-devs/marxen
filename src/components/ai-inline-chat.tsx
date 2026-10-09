import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { MarkdownPreview } from "./preview/MarkdownPreview";
import { describeAiError, startPrompt } from "../lib/ai";
import {
  claudeRefusalError,
  isClaudeBlockedProvider,
  keepStartedSession,
  normalizeAiError,
  useAiRun,
} from "../lib/ai-run";
import { truncatePrompt } from "../lib/ai-conversation";
import type {
  AiError,
  AiPromptRequest,
  AiProviderConfig,
  ContextSummary,
  PromptContext,
  PromptMode,
  ProposalText,
  StagingTarget,
} from "../shared/ai-contracts";

export interface InlineChatProps {
  documentId: string;
  /** Visible filename for the target document (no internal ids in product text). */
  documentLabel: string;
  target: { start: number; end: number; kind: "selection" | "paragraph"; excerpt: string };
  context: PromptContext;
  staging: StagingTarget | null;
  ensureStaging: (contexts: PromptContext[]) => Promise<StagingTarget>;
  provider: AiProviderConfig;
  /** Fenced while the Agent chat owns a run on the shared staging slot. */
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onProposal: (proposal: ProposalText, sent: ContextSummary[], mode: PromptMode) => void;
  onReview: () => void;
  onClose: () => void;
  anchor?: () => { left: number; top: number; bottom: number } | null;
}

export default function InlineChat({
  documentLabel,
  target,
  context,
  ensureStaging,
  provider,
  disabled,
  onBusyChange,
  onProposal,
  onReview,
  onClose,
  anchor,
}: InlineChatProps) {
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState("");
  const [proposal, setProposal] = useState<ProposalText | null>(null);
  const [error, setError] = useState<AiError | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const run = useAiRun(onBusyChange);
  const setBusy = run.setBusy;
  const onProposalRef = useRef(onProposal);
  onProposalRef.current = onProposal;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 16, top: 64 });

  useLayoutEffect(() => {
    const place = () => {
      const box = dialogRef.current?.getBoundingClientRect();
      const caret = anchor?.();
      if (!box || !caret) return;
      const left = Math.max(12, Math.min(caret.left, window.innerWidth - box.width - 12));
      const below = caret.bottom + 8;
      const top = Math.max(12, Math.min(below + box.height <= window.innerHeight - 12
        ? below : caret.top - box.height - 8, window.innerHeight - box.height - 12));
      setPosition((previous) => previous.left === left && previous.top === top ? previous : { left, top });
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    if (dialogRef.current) observer?.observe(dialogRef.current);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
      observer?.disconnect();
    };
  }, [anchor]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Unmount cleanup (cancel the owned run so late callbacks settle fenced)
  // lives in the shared hook: closing without an explicit cancel still
  // cancels through that path when the shell unmounts the composer.

  async function handleSend() {
    const trimmed = truncatePrompt(prompt.trim());
    if (trimmed === "" || running || run.ownedBusy || disabled) return;
    const blockedCommand = isClaudeBlockedProvider(provider);
    if (blockedCommand !== null) {
      setError(claudeRefusalError(blockedCommand));
      return;
    }
    const token = run.beginRun();
    const capturedContext = { ...context, ranges: [...context.ranges] };
    const capturedProvider = provider;
    setRunning(true);
    setBusy(true);
    setOutput("");
    setProposal(null);
    setError(null);
    setCancelled(false);
    let resolved: StagingTarget;
    try {
      resolved = await ensureStaging([capturedContext]);
    } catch (cause) {
      if (!run.isCurrent(token)) { setBusy(false, token); return; }
      setRunning(false);
      setBusy(false);
      setError(normalizeAiError(cause));
      return;
    }
    if (!run.isCurrent(token)) { setBusy(false, token); return; }
    if (run.isCancelRequested()) {
      setRunning(false);
      setBusy(false);
      setCancelled(true);
      return;
    }
    const request: AiPromptRequest = {
      provider: capturedProvider,
      mode: "rewrite",
      prompt: trimmed,
      contexts: [capturedContext],
      staging: resolved,
      sessionId: null,
      history: [],
    };
    try {
      const session = await startPrompt(request, (event) => {
        if (!run.isCurrent(token)) return;
        if (run.isSettled(token)) return;
        if (run.isCancelRequested()) {
          if (event.type === "chunk" || event.type === "started") return;
          run.markSettled(token);
          setCancelled(true);
          setRunning(false);
          setBusy(false);
          run.takeStop();
          return;
        }
        switch (event.type) {
          case "chunk":
            setOutput((previous) => previous + event.payload.text);
            break;
          case "done":
            run.markSettled(token);
            setProposal(event.payload.proposal);
            onProposalRef.current(event.payload.proposal, event.payload.sent, "rewrite");
            setRunning(false);
            setBusy(false);
            run.takeStop();
            break;
          case "error":
            run.markSettled(token);
            setError(event.payload.error);
            setRunning(false);
            setBusy(false);
            run.takeStop();
            break;
          case "cancelled":
            run.markSettled(token);
            setCancelled(true);
            setRunning(false);
            setBusy(false);
            run.takeStop();
            break;
          case "started":
            break;
        }
      });
      if (!(await keepStartedSession(run, token, session.stop))) return;
    } catch (cause) {
      if (!run.isCurrent(token)) { setBusy(false, token); return; }
      run.markSettled(token);
      setRunning(false);
      setBusy(false);
      setError(normalizeAiError(cause));
    }
  }

  async function handleCancel() {
    await run.cancelOwned();
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      void handleCancel().finally(() => onCloseRef.current());
    }
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-label="インラインチャット"
      data-testid="inline-chat"
      className="fixed z-40 max-h-[calc(100dvh-24px)] w-96 max-w-[calc(100vw-24px)] overflow-y-auto rounded-md border border-border bg-card p-3 shadow-lg"
      style={anchor ? position : undefined}
      onKeyDown={handleKeyDown}
    >
      <div className="flex items-center gap-1">
        <p className="min-w-0 flex-1 truncate text-xs font-medium">
          インラインチャット（{target.kind === "selection" ? "選択" : "段落"}）
        </p>
        <button
          type="button"
          aria-label="インラインチャットを閉じる"
          title="閉じる"
          className="rounded px-1.5 py-0.5 text-xs hover:bg-muted"
          onClick={() => {
            void handleCancel().finally(() => onClose());
          }}
        >
          ×
        </button>
      </div>
      <p className="mt-1 truncate text-[11px] text-muted-foreground" title={`rev ${context.revision}`}>
        {documentLabel}
      </p>
      {target.excerpt !== "" && (
        <p className="mt-1 max-h-20 overflow-y-auto whitespace-pre-wrap rounded-md border border-border p-1.5 text-[11px]">
          {target.excerpt}
        </p>
      )}
      <textarea
        ref={inputRef}
        aria-label="インライン指示"
        className="mt-1 block max-h-32 w-full overflow-y-auto rounded-md border border-border bg-card px-2 py-1.5 text-xs"
        rows={2}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="選択範囲への指示を書きます"
      />
      <div className="mt-1 flex gap-1">
        <Button size="sm" aria-label="インライン送信" onClick={() => void handleSend()} disabled={running || disabled || prompt.trim() === ""}>
          {running ? "送信中…" : "送信"}
        </Button>
        {running && (
          <Button variant="outline" size="sm" aria-label="インライン取消" onClick={() => void handleCancel()}>
            取消
          </Button>
        )}
        {proposal && (
          <Button variant="outline" size="sm" aria-label="差分を確認" title="提案を作業コピーに取り込み差分を確認します" onClick={onReview}>
            差分を確認
          </Button>
        )}
      </div>
      {disabled && <p className="mt-1 text-[11px] text-muted-foreground">他の応答を生成しています。</p>}
      <div aria-live="polite" className="mt-1">
        {output && !proposal && <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-xs">{output}</p>}
        {cancelled && <p className="text-xs">取り消しました。</p>}
        {error && (
          <p role="alert" className="text-xs font-medium text-red-600">{describeAiError(error)}</p>
        )}
        {proposal && (
          <div className="mt-1 rounded-md border border-border p-1.5">
            <p className="text-[11px] font-medium text-muted-foreground">提案</p>
            <div className="marxen-chat-body mt-1 max-h-48 overflow-y-auto"><MarkdownPreview text={proposal.text} label="インラインの提案" testId="inline-response" /></div>
          </div>
        )}
      </div>
    </div>
  );
}
