import { useState } from "react";
import { Button } from "./ui/button";
import { cancelPromptSafe, describeAiError, describeInvokeError, isClaudeCommand, startPrompt } from "../lib/ai";
import { toHistoryPayload } from "../lib/ai-conversation";
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
  target: { start: number; end: number; kind: "selection" | "paragraph"; excerpt: string };
  context: PromptContext;
  staging: StagingTarget | null;
  ensureStaging: (contexts: PromptContext[]) => Promise<StagingTarget>;
  provider: AiProviderConfig;
  onProposal: (proposal: ProposalText, sent: ContextSummary[], mode: PromptMode) => void;
  onReview: () => void;
  onClose: () => void;
}

export default function InlineChat({
  documentId,
  target,
  context,
  staging,
  ensureStaging,
  provider,
  onProposal,
  onReview,
  onClose,
}: InlineChatProps) {
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState("");
  const [proposal, setProposal] = useState<ProposalText | null>(null);
  const [sent, setSent] = useState<ContextSummary[]>([]);
  const [error, setError] = useState<AiError | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [stopFn, setStopFn] = useState<(() => Promise<void>) | null>(null);

  async function handleSend() {
    const trimmed = prompt.trim().slice(0, 20_000);
    if (trimmed === "" || running) return;
    if (provider.kind === "acp" && provider.acp?.preset === "custom" && isClaudeCommand(provider.acp.argv?.command ?? "")) {
      setError({ code: "claude_code_refused", command: (provider.acp.argv?.command ?? "").trim() });
      return;
    }
    setRunning(true);
    setOutput("");
    setProposal(null);
    setSent([]);
    setError(null);
    setCancelled(false);
    let resolved = staging;
    try {
      resolved = staging ?? (await ensureStaging([context]));
    } catch (cause) {
      setRunning(false);
      setError(
        typeof cause === "object" && cause !== null && "code" in cause
          ? (cause as AiError)
          : { code: "connection_failed", detail: describeInvokeError(cause) },
      );
      return;
    }
    const request: AiPromptRequest = {
      provider,
      mode: "rewrite",
      prompt: trimmed,
      contexts: [context],
      staging: resolved,
      sessionId: null,
      history: [],
    };
    void toHistoryPayload([]);
    try {
      const session = await startPrompt(request, (event) => {
        switch (event.type) {
          case "chunk":
            setOutput((previous) => previous + event.payload.text);
            break;
          case "done":
            setProposal(event.payload.proposal);
            setSent(event.payload.sent);
            onProposal(event.payload.proposal, event.payload.sent, "rewrite");
            setRunning(false);
            setStopFn(null);
            break;
          case "error":
            setError(event.payload.error);
            setRunning(false);
            setStopFn(null);
            break;
          case "cancelled":
            setCancelled(true);
            setRunning(false);
            setStopFn(null);
            break;
          case "started":
            break;
        }
      });
      setStopFn(() => session.stop);
    } catch (cause) {
      setRunning(false);
      setError(
        typeof cause === "object" && cause !== null && "code" in cause
          ? (cause as AiError)
          : { code: "connection_failed", detail: describeInvokeError(cause) },
      );
    }
  }

  async function handleCancel() {
    if (stopFn) await cancelPromptSafe(stopFn);
  }

  return (
    <div
      role="dialog"
      aria-label="インライン chat"
      data-testid="inline-chat"
      className="w-80 rounded-lg border border-border bg-card p-2 shadow-lg"
    >
      <div className="flex items-center gap-1">
        <p className="min-w-0 flex-1 truncate text-xs font-medium">
          インライン編集（{target.kind === "selection" ? "選択" : "段落"} [{target.start}, {target.end})）
        </p>
        <button
          type="button"
          aria-label="インライン chat を閉じる"
          title="閉じる"
          className="rounded px-1.5 py-0.5 text-xs hover:bg-muted"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={documentId}>
        {documentId} rev {context.revision}
      </p>
      <textarea
        aria-label="インライン指示"
        className="mt-1 block w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs"
        rows={2}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="選択範囲への指示を書きます"
      />
      <div className="mt-1 flex gap-1">
        <Button size="sm" aria-label="インライン送信" onClick={() => void handleSend()} disabled={running || prompt.trim() === ""}>
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
      <div aria-live="polite" className="mt-1">
        {output && !proposal && <p className="whitespace-pre-wrap text-xs">{output}</p>}
        {cancelled && <p className="text-xs">取り消しました。</p>}
        {error && (
          <p role="alert" className="text-xs font-medium text-red-600">{describeAiError(error)}</p>
        )}
        {proposal && (
          <div className="mt-1 rounded-md border border-border p-1.5">
            <p className="text-[11px] font-medium text-muted-foreground">提案（Markdownは変更しません）</p>
            <p className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-xs">{proposal.text}</p>
            {sent.length > 0 && (
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                {sent[0].documentId} rev {sent[0].revision}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
