import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { MarkdownPreview } from "./preview/MarkdownPreview";
import { cancelPromptSafe, describeAiError, describeInvokeError, isClaudeCommand, startPrompt } from "../lib/ai";
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
  const runTokenRef = useRef(0);
  const cancelRequestedRef = useRef(false);
  const settledTokenRef = useRef(-1);
  const stopRef = useRef<(() => Promise<void>) | null>(null);
  const onProposalRef = useRef(onProposal);
  onProposalRef.current = onProposal;
  const onBusyChangeRef = useRef(onBusyChange);
  onBusyChangeRef.current = onBusyChange;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const busyRef = useRef(false);
  const ownedTokenRef = useRef(-1);
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

  // Unmount cleanup cancels the owned run so late callbacks settle fenced.
  // Closing without an explicit cancel still cancels through this path when
  // the shell unmounts the composer.
  useEffect(() => {
    return () => {
      runTokenRef.current += 1;
      const stop = stopRef.current;
      stopRef.current = null;
      if (stop) void cancelPromptSafe(stop).finally(() => onBusyChangeRef.current?.(false));
    };
  }, []);

  function setBusy(next: boolean, token = runTokenRef.current) {
    if (!next && token !== ownedTokenRef.current) return;
    if (next) ownedTokenRef.current = token;
    busyRef.current = next;
    onBusyChangeRef.current?.(next);
  }

  async function handleSend() {
    const trimmed = prompt.trim().slice(0, 20_000);
    if (trimmed === "" || running || busyRef.current || disabled) return;
    if (provider.kind === "acp" && provider.acp?.preset === "custom" && isClaudeCommand(provider.acp.argv?.command ?? "")) {
      setError({ code: "claude_code_refused", command: (provider.acp.argv?.command ?? "").trim() });
      return;
    }
    const token = runTokenRef.current + 1;
    runTokenRef.current = token;
    cancelRequestedRef.current = false;
    settledTokenRef.current = -1;
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
      if (token !== runTokenRef.current) { setBusy(false, token); return; }
      setRunning(false);
      setBusy(false);
      setError(
        typeof cause === "object" && cause !== null && "code" in cause
          ? (cause as AiError)
          : { code: "connection_failed", detail: describeInvokeError(cause) },
      );
      return;
    }
    if (token !== runTokenRef.current) { setBusy(false, token); return; }
    if (cancelRequestedRef.current) {
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
        if (token !== runTokenRef.current) return;
        if (settledTokenRef.current === token) return;
        if (cancelRequestedRef.current) {
          if (event.type === "chunk" || event.type === "started") return;
          settledTokenRef.current = token;
          setCancelled(true);
          setRunning(false);
          setBusy(false);
          stopRef.current = null;
          return;
        }
        switch (event.type) {
          case "chunk":
            setOutput((previous) => previous + event.payload.text);
            break;
          case "done":
            settledTokenRef.current = token;
            setProposal(event.payload.proposal);
            onProposalRef.current(event.payload.proposal, event.payload.sent, "rewrite");
            setRunning(false);
            setBusy(false);
            stopRef.current = null;
            break;
          case "error":
            settledTokenRef.current = token;
            setError(event.payload.error);
            setRunning(false);
            setBusy(false);
            stopRef.current = null;
            break;
          case "cancelled":
            settledTokenRef.current = token;
            setCancelled(true);
            setRunning(false);
            setBusy(false);
            stopRef.current = null;
            break;
          case "started":
            break;
        }
      });
      if (token !== runTokenRef.current || settledTokenRef.current === token || cancelRequestedRef.current) {
        await cancelPromptSafe(session.stop);
        setBusy(false, token);
        return;
      }
      stopRef.current = session.stop;
    } catch (cause) {
      if (token !== runTokenRef.current) { setBusy(false, token); return; }
      settledTokenRef.current = token;
      setRunning(false);
      setBusy(false);
      setError(
        typeof cause === "object" && cause !== null && "code" in cause
          ? (cause as AiError)
          : { code: "connection_failed", detail: describeInvokeError(cause) },
      );
    }
  }

  async function handleCancel() {
    cancelRequestedRef.current = true;
    const stop = stopRef.current;
    if (stop) await cancelPromptSafe(stop);
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
