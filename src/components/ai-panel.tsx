import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import AiProviderSettings from "./ai-provider-settings";
import {
  buildProviderConfig,
  cancelPromptSafe,
  describeAiError,
  describeInvokeError,
  isClaudeCommand,
  startPrompt,
  summarizeContext,
} from "../lib/ai";
import { loadAiProfile, saveAiProfile } from "../lib/ai-profiles";
import {
  appendStreamingText,
  cancelAssistant,
  createConversation,
  createStreamingAssistant,
  createUserMessage,
  dropTrailingFailedExchange,
  failAssistant,
  finalizeAssistant,
  isBusy,
  lastUserPrompt,
  retryHistory,
  toHistoryPayload,
  truncatePrompt,
  type ChatConversation,
} from "../lib/ai-conversation";
import type {
  AiError,
  AiPromptRequest,
  AiProviderConfig,
  AiStreamEvent,
  ContextSummary,
  CredentialRef,
  PromptContext,
  PromptMode,
  ProposalText,
  StagingTarget,
} from "../shared/ai-contracts";

export interface AiPanelProps {
  contexts: PromptContext[];
  staging: StagingTarget | null;
  /** Auto-prepare the isolation copy on send; falls back to `staging` when absent. */
  ensureStaging?: (contexts: PromptContext[]) => Promise<StagingTarget>;
  /** Controlled provider shared with inline chat; uncontrolled when absent. */
  provider?: AiProviderConfig;
  onProvider?: (provider: AiProviderConfig) => void;
  /** Increment to expand the collapsed connection settings (root Settings entry point). */
  openSettingsToken?: number;
  onRemoveContext?: (documentId: string) => void;
  /**
   * Called once per completed run with the proposal text and the mode it was
   * sent with. The proposal never edits the document: review/apply belongs
   * to the Issue #8 ReviewPanel, which consumes the same (proposal, sent)
   * pair via `stageProposal`. `ask` proposals display only and are refused
   * by staging.
   */
  onProposal?: (proposal: ProposalText, sent: ContextSummary[], mode: PromptMode) => void;
}

const MODE_ORDER: PromptMode[] = ["ask", "generate", "rewrite", "workspace"];

export const MODE_LABELS: Record<PromptMode, string> = {
  ask: "質問",
  generate: "生成",
  rewrite: "選択書き換え",
  workspace: "workspace 修正",
};

// Kept for existing imports; the implementation lives in `lib/ai`.
export { buildProviderConfig };

export default function AiPanel({ contexts, staging, ensureStaging, provider: controlled, onProvider, openSettingsToken, onRemoveContext, onProposal }: AiPanelProps) {
  const [saved] = useState(loadAiProfile);
  const [internal, setInternal] = useState<AiProviderConfig>(() => buildProviderConfig(saved));
  const provider = controlled ?? internal;
  const setProvider = (next: AiProviderConfig) => {
    if (onProvider) onProvider(next);
    else setInternal(next);
  };
  const [mode, setMode] = useState<PromptMode>("ask");
  const [prompt, setPrompt] = useState("");
  const [conversation, setConversation] = useState<ChatConversation>(() => createConversation());
  const [streamError, setStreamError] = useState<AiError | null>(null);
  const [stopFn, setStopFn] = useState<(() => Promise<void>) | null>(null);
  const [assistantId, setAssistantId] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const contextsRef = useRef(contexts);
  contextsRef.current = contexts;
  const stagingRef = useRef(staging);
  stagingRef.current = staging;
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    saveAiProfile({
      kind: provider.kind,
      preset: provider.acp?.preset ?? saved.preset,
      command: provider.acp?.argv?.command ?? saved.command,
      argsText: (provider.acp?.argv?.args ?? []).join("\n") || saved.argsText,
      endpoint: provider.openai?.endpoint ?? provider.anthropic?.endpoint ?? saved.endpoint,
      model: provider.openai?.model ?? provider.anthropic?.model ?? saved.model,
      anthropicEnabled: provider.anthropic?.enabled ?? saved.anthropicEnabled,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  useEffect(() => {
    const node = transcriptRef.current;
    if (node && typeof node.scrollTo === "function") {
      node.scrollTo({ top: node.scrollHeight });
    }
  }, [conversation.messages.length]);

  const running = isBusy(conversation.messages) || resolving;
  const anthropicBlocked = provider.kind === "anthropic" && !(provider.anthropic?.enabled ?? false);
  const canSend = !running && prompt.trim().length > 0 && !anthropicBlocked;

  async function resolveStaging(): Promise<StagingTarget> {
    if (stagingRef.current) return stagingRef.current;
    if (ensureStaging) {
      const current = contextsRef.current;
      if (current.length === 0) {
        throw { code: "staging_unresolved", copy_id: "(未解決)" } satisfies AiError;
      }
      return ensureStaging(current);
    }
    throw { code: "staging_unresolved", copy_id: "(未解決)" } satisfies AiError;
  }

  function handleEvent(event: AiStreamEvent, assistant: string) {
    switch (event.type) {
      case "started":
        break;
      case "chunk":
        setConversation((prev) => ({
          ...prev,
          messages: appendStreamingText(prev.messages, assistant, event.payload.text),
        }));
        break;
      case "done":
        setConversation((prev) => ({
          ...prev,
          messages: finalizeAssistant(prev.messages, assistant, event.payload.proposal, event.payload.sent),
        }));
        onProposal?.(event.payload.proposal, event.payload.sent, modeRef.current);
        setStopFn(null);
        setAssistantId(null);
        break;
      case "error":
        setConversation((prev) => ({ ...prev, messages: failAssistant(prev.messages, assistant, event.payload.error) }));
        setStopFn(null);
        setAssistantId(null);
        break;
      case "cancelled":
        setConversation((prev) => ({ ...prev, messages: cancelAssistant(prev.messages, assistant) }));
        setStopFn(null);
        setAssistantId(null);
        break;
    }
  }

  async function sendWith(promptText: string, promptMode: PromptMode, promptContexts: PromptContext[], history: { role: "user" | "assistant"; text: string }[]) {
    const trimmed = truncatePrompt(promptText).trim();
    if (trimmed === "") return;
    if (provider.kind === "acp" && provider.acp?.preset === "custom" && isClaudeCommand(provider.acp.argv?.command ?? "")) {
      setStreamError({ code: "claude_code_refused", command: (provider.acp.argv?.command ?? "").trim() });
      return;
    }
    setResolving(true);
    setStreamError(null);
    let resolved: StagingTarget;
    try {
      resolved = await resolveStaging();
    } catch (cause) {
      setResolving(false);
      setStreamError(
        typeof cause === "object" && cause !== null && "code" in cause
          ? (cause as AiError)
          : { code: "connection_failed", detail: describeInvokeError(cause) },
      );
      return;
    }
    const userMessage = createUserMessage(trimmed, promptMode, promptContexts);
    const assistant = createStreamingAssistant();
    setConversation((prev) => ({ ...prev, messages: [...prev.messages, userMessage, assistant] }));
    setAssistantId(assistant.id);
    setResolving(false);
    const request: AiPromptRequest = {
      provider,
      mode: promptMode,
      prompt: trimmed,
      contexts: promptContexts,
      staging: resolved,
      sessionId: null,
      history,
    };
    try {
      const session = await startPrompt(request, (event) => handleEvent(event, assistant.id));
      setStopFn(() => session.stop);
    } catch (cause) {
      setConversation((prev) => ({
        ...prev,
        messages: failAssistant(
          prev.messages,
          assistant.id,
          typeof cause === "object" && cause !== null && "code" in cause
            ? (cause as AiError)
            : { code: "connection_failed", detail: describeInvokeError(cause) },
        ),
      }));
      setStreamError(
        typeof cause === "object" && cause !== null && "code" in cause
          ? (cause as AiError)
          : { code: "connection_failed", detail: describeInvokeError(cause) },
      );
      setAssistantId(null);
    }
  }

  async function handleSend() {
    if (running) return;
    const history = toHistoryPayload(conversation.messages);
    await sendWith(prompt, mode, contextsRef.current, history);
    setPrompt("");
  }

  async function handleCancel() {
    if (stopFn) await cancelPromptSafe(stopFn);
  }

  async function handleRetry() {
    if (running) return;
    const last = lastUserPrompt(conversation.messages);
    if (!last) return;
    setConversation((prev) => ({ ...prev, messages: dropTrailingFailedExchange(prev.messages) }));
    const history = retryHistory(conversation.messages);
    await sendWith(last.prompt, last.mode, last.contexts.length > 0 ? last.contexts : contextsRef.current, history);
  }

  function handleNewConversation() {
    if (running && stopFn) void cancelPromptSafe(stopFn);
    setConversation(createConversation());
    setStreamError(null);
    setStopFn(null);
    setAssistantId(null);
    setPrompt("");
  }

  return (
    <div aria-label="エージェントチャット" className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-1">
        <h2 id="ai-panel-title" className="min-w-0 flex-1 truncate text-sm font-semibold">エージェント</h2>
        <Button variant="outline" size="sm" aria-label="新しい会話" title="新しい会話" onClick={handleNewConversation}>
          新規
        </Button>
      </div>
      <div className="flex flex-wrap gap-1" aria-label="送信対象">
        {contexts.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">送信対象がありません。</span>
        ) : (
          contexts.map((context) => (
            <span key={context.documentId} className="inline-flex max-w-full items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px]">
              <span className="truncate font-mono">{summarizeContext(context)}</span>
              {onRemoveContext && (
                <button
                  type="button"
                  aria-label={`${context.documentId}を外す`}
                  title="外す"
                  className="rounded px-1 hover:bg-muted"
                  onClick={() => onRemoveContext(context.documentId)}
                >
                  ×
                </button>
              )}
            </span>
          ))
        )}
        <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 font-mono text-[11px]">
          {staging ? staging.copyId : "未解決→送信時に自動登録"}
        </span>
      </div>
      <div ref={transcriptRef} aria-live="polite" aria-label="会話" className="min-h-40 flex-1 space-y-2 overflow-y-auto rounded-lg border border-border p-2">
        {conversation.messages.length === 0 && (
          <p className="text-[11px] text-muted-foreground">質問や生成指示を下に入力して送信します。履歴は HTTP 接続先にも明示して送ります。</p>
        )}
        {conversation.messages.map((message) =>
          message.role === "user" ? (
            <div key={message.id} className="rounded-lg bg-muted p-2 text-xs">
              <p className="font-medium">あなた・{MODE_LABELS[message.mode ?? mode]}</p>
              <p className="mt-1 whitespace-pre-wrap">{message.text}</p>
            </div>
          ) : (
            <div key={message.id} className="rounded-lg border border-border p-2 text-xs">
              <p className="font-medium">
                AI{message.state === "streaming" ? "・生成中…" : message.state === "cancelled" ? "・取消済み" : message.state === "error" ? "・失敗" : ""}
              </p>
              {message.text && <p className="mt-1 whitespace-pre-wrap">{message.text}</p>}
              {message.proposal && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  基準: {message.proposal.baseContexts.map((ref) => `${ref.documentId} rev ${ref.revision}`).join(", ")}（Markdownは変更しません）
                </p>
              )}
              {message.state === "error" && message.error && (
                <p role="alert" className="mt-1 font-medium text-red-600">{describeAiError(message.error)}</p>
              )}
              {message.state === "cancelled" && <p className="mt-1">取り消しました。</p>}
            </div>
          ),
        )}
        {streamError && (
          <p role="alert" className="text-xs font-medium text-red-600">{describeAiError(streamError)}</p>
        )}
        {assistantId && (
          <p className="text-[11px] text-muted-foreground">応答を生成しています…</p>
        )}
      </div>
      <div className="shrink-0 space-y-2 border-t border-border pt-2">
        <div role="group" aria-label="プロンプトの種類" className="flex flex-wrap gap-2">
          {MODE_ORDER.map((candidate) => (
            <label key={candidate} className="inline-flex items-center gap-1 text-xs">
              <input
                type="radio"
                name="ai-prompt-mode"
                checked={mode === candidate}
                onChange={() => setMode(candidate)}
              />
              {MODE_LABELS[candidate]}
            </label>
          ))}
        </div>
        <textarea
          aria-label="プロンプト"
          className="block w-full rounded-lg border border-border bg-card px-2 py-1.5 text-xs"
          rows={3}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="AI への指示を書きます"
        />
        <div className="flex gap-1">
          <Button size="sm" aria-label="送信" onClick={() => void handleSend()} disabled={!canSend}>
            {running ? "送信中…" : "送信"}
          </Button>
          {running && (
            <Button variant="outline" size="sm" aria-label="取り消し" onClick={() => void handleCancel()}>
              取消
            </Button>
          )}
          {!running && (
            <Button variant="outline" size="sm" aria-label="再試行" title="直前の入力を再送します" onClick={() => void handleRetry()} disabled={!lastUserPrompt(conversation.messages)}>
              再試行
            </Button>
          )}
        </div>
        {anthropicBlocked && <p className="text-[11px] text-muted-foreground">Anthropic を有効化すると送信できます。</p>}
        <AiProviderSettings provider={provider} onProvider={setProvider} openToken={openSettingsToken} />
        <p className="text-[11px] text-muted-foreground">回答は提案テキストです。反映は差分レビューを経ます。</p>
      </div>
    </div>
  );
}

// Re-exported for tests that import labels from the panel module.
export type { CredentialRef };
