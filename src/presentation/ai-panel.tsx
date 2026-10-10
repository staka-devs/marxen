import { useEffect, useRef, useState } from "react";
import { History, Plus, RotateCcw, Send, Square, X } from "lucide-react";
import { Button } from "./ui/button";
import "./ai-chat.css";
import AiProviderSettings from "./ai-provider-settings";
import { MarkdownPreview } from "./preview/MarkdownPreview";
import {
  MODE_LABELS,
  PRESET_LABELS,
  buildProviderConfig,
  describeAiError,
} from "../domain/ai-config";
import {
  claudeRefusalError,
  isClaudeBlockedProvider,
  keepStartedSession,
  normalizeAiError,
} from "../application/ai/ai-run-core";
import { useAiRun } from "./ai/use-ai-run";
import { defaultProfile, type AiProfile } from "../domain/ai-profile";
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
} from "../domain/conversation/ai-conversation";
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
} from "../contracts/ai-contracts";
import type { AiGateway, AiProfileStore } from "../application/ports";

export interface AiPanelProps {
  contexts: PromptContext[];
  staging: StagingTarget | null;
  /** Always validates the exact contexts; reuses the copy only on exact match. */
  ensureStaging?: (contexts: PromptContext[]) => Promise<StagingTarget>;
  /** Controlled provider shared with inline chat; uncontrolled when absent. */
  provider?: AiProviderConfig;
  /** Replace the shared provider configuration. */
  onProvider?: (provider: AiProviderConfig) => void;
  /** Increment to expand the collapsed connection settings (root Settings entry point). */
  openSettingsToken?: number;
  /** Compact header close control; root wires it to hide the AI pane. */
  onClose?: () => void;
  /** Visible filename labels per document id (no internal ids in product text). */
  contextLabels?: Record<string, string>;
  /** Fenced while the other chat owns a run on the shared staging slot. */
  disabled?: boolean;
  /** Broadcast busy ownership for the shared staging fence. */
  onBusyChange?: (busy: boolean) => void;
  /** Drop one document from the send scope. */
  onRemoveContext?: (documentId: string) => void;
  /**
   * Called once per completed run with the proposal text and the mode it was
   * sent with. The proposal never edits the document: review/apply belongs
   * to the Issue #8 ReviewPanel, which consumes the same (proposal, sent)
   * pair via `stageProposal`. `ask` proposals display only and are refused
   * by staging. Stale runs (reset, conversation switch, provider change,
   * unmount) never call this.
   */
  onProposal?: (proposal: ProposalText, sent: ContextSummary[], mode: PromptMode) => void;
  /** Streaming transport injected by the composition root; never imported directly. */
  startPrompt?: AiGateway["startPrompt"];
  /** Non-secret profile store injected by the composition root. */
  profileStore?: AiProfileStore;
  /** Credential/connection gateway forwarded to the settings subview. */
  aiGateway?: AiGateway;
}

const MODE_ORDER: PromptMode[] = ["ask", "generate", "rewrite", "workspace"];

// Single-sourced in domain; re-exported for existing label imports.
export { MODE_LABELS };

/**
 * Empty-chat examples filling the composer when clicked.
 *
 * Kept as plain prompts (never sent automatically) so keyboard and
 * screen-reader users can review before sending.
 */
const EMPTY_EXAMPLES: readonly string[] = [
  "この文書の要点を3行で教えてください。",
  "選択範囲を読みやすく書き直してください。",
] as const;

// Kept for existing imports; the implementation lives in domain.
export { buildProviderConfig };

/**
 * Map a document ID to its visible filename label, falling back to generic.
 *
 * Never exposes internal IDs in product text.
 */
function labelFor(labels: Record<string, string> | undefined, documentId: string): string {
  return labels?.[documentId] ?? "現在の文書";
}

/**
 * Describe the active connection neutrally for chips and tooltips.
 *
 * Shows preset or model fragments only; liveness is never invented here and
 * stays with the explicit connection test in the settings subview.
 */
function panelProviderSummary(provider: AiProviderConfig): string {
  if (provider.kind === "acp") {
    if (provider.acp?.preset === "custom") {
      const command = provider.acp.argv?.command?.trim() ?? "";
      return command === "" ? "カスタム" : `カスタム • ${command}`;
    }
    return PRESET_LABELS[provider.acp?.preset ?? "codex"] ?? "ACP";
  }
  if (provider.kind === "openai_compatible") {
    const model = provider.openai?.model?.trim() ?? "";
    return model === "" ? "OpenAI互換" : `OpenAI互換 • ${model}`;
  }
  const model = provider.anthropic?.model?.trim() ?? "";
  const enabled = provider.anthropic?.enabled ?? false;
  if (!enabled) return model === "" ? "Anthropic（無効）" : `Anthropic • ${model}（無効）`;
  return model === "" ? "Anthropic" : `Anthropic • ${model}`;
}

/**
 * Load the saved profile through the injected store or domain defaults.
 *
 * Falls back to Codex defaults when no store is wired (tests, browser demo).
 */
function loadSavedProfile(store: AiProfileStore | undefined): AiProfile {
  try {
    return store?.load() ?? defaultProfile();
  } catch {
    return defaultProfile();
  }
}

/**
 * Agent multi-turn chat with staging, history, and fenced runs.
 *
 * Sends through the injected transport with exact contexts; proposals flow to
 * review via `onProposal` and never edit directly. Stale runs never publish.
 */
export default function AiPanel({
  contexts,
  staging,
  ensureStaging,
  provider: controlled,
  onProvider,
  openSettingsToken,
  contextLabels,
  disabled,
  onBusyChange,
  onClose,
  onRemoveContext,
  onProposal,
  startPrompt: startPromptProp,
  profileStore,
  aiGateway,
}: AiPanelProps) {
  /** Streaming transport: injected prop wins, otherwise the test fallback throws visibly. */
  const startPromptFn: AiGateway["startPrompt"] = startPromptProp
    ?? aiGateway?.startPrompt
    ?? (async () => { throw new Error("AI transport is not wired."); });
  const [saved] = useState(() => loadSavedProfile(profileStore));
  const [internal, setInternal] = useState<AiProviderConfig>(() => buildProviderConfig(saved));
  const provider = controlled ?? internal;
  const providerKey = JSON.stringify(provider);
  const providerKeyRef = useRef(providerKey);
  // In-memory conversation list: 新規 preserves prior conversations in the
  // selector instead of destroying them. Nothing persists to storage.
  const [conversations, setConversations] = useState<ChatConversation[]>(() => [createConversation(providerKey)]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mode, setMode] = useState<PromptMode>("ask");
  const [prompt, setPrompt] = useState("");
  const [streamError, setStreamError] = useState<AiError | null>(null);
  const [resolving, setResolving] = useState(false);
  // One active run token owned by the shared hook: every send fences the
  // previous run, and every terminal/reset/unmount path retires it. Stale
  // callbacks check the token before touching messages, proposals, or busy
  // state. Early IPC events stay buffered in `lib/ai`.
  const run = useAiRun(onBusyChange);
  const { ownedBusy } = run;
  const setBusy = run.setBusy;
  const onProposalRef = useRef(onProposal);
  onProposalRef.current = onProposal;
  const conversation = activeId
    ? (conversations.find((item) => item.id === activeId) ?? conversations[0])
    : (conversations[0] ?? null);
  const conversationId = conversation?.id ?? "";
  const activeIdRef = useRef<string>("");
  activeIdRef.current = conversationId;
  const transcriptRef = useRef<HTMLDivElement>(null);

  /** Apply an update to one conversation by ID preserving others. */ function applyToConversation(id: string, update: (prev: ChatConversation) => ChatConversation) {
    setConversations((prev) => prev.map((item) => (item.id === id ? update(item) : item)));
  }

  /** Fence the run and mark streaming messages cancelled without touching state. */ function fenceRun() {
    run.fence();
    setConversations((previous) => previous.map((item) => ({
      ...item,
      messages: item.messages.map((message) => message.state === "streaming"
        ? { ...message, state: "cancelled" as const } : message),
    })));
    setResolving(false);
  }

  /** Switch provider key, preserving empty drafts and fencing runs. */ function moveToProvider(nextKey: string) {
    fenceRun();
    providerKeyRef.current = nextKey;
    if (conversation && conversation.messages.length === 0) {
      applyToConversation(conversation.id, (previous) => ({ ...previous, providerKey: nextKey }));
    } else {
      const next = createConversation(nextKey);
      setConversations((previous) => [...previous, next]);
      setActiveId(next.id);
    }
    setStreamError(null);
  }

  /** Change provider when different, moving conversation and notifying. */ function changeProvider(next: AiProviderConfig) {
    if (JSON.stringify(provider) === JSON.stringify(next)) return;
    moveToProvider(JSON.stringify(next));
    if (onProvider) onProvider(next);
    else setInternal(next);
  }

  useEffect(() => {
    if (providerKeyRef.current === providerKey) return;
    moveToProvider(providerKey);
  }, [providerKey]);

  useEffect(() => {
    try {
      profileStore?.save({
        kind: provider.kind,
        preset: provider.acp?.preset ?? saved.preset,
        command: provider.acp?.argv?.command ?? saved.command,
        argsText: (provider.acp?.argv?.args ?? []).join("\n") || saved.argsText,
        endpoint: provider.openai?.endpoint ?? provider.anthropic?.endpoint ?? saved.endpoint,
        model: provider.openai?.model ?? provider.anthropic?.model ?? saved.model,
        anthropicEnabled: provider.anthropic?.enabled ?? saved.anthropicEnabled,
      });
    } catch {
      // Private mode/quota: profiles simply do not persist.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  useEffect(() => {
    const node = transcriptRef.current;
    if (node && typeof node.scrollTo === "function") {
      node.scrollTo({ top: node.scrollHeight });
    }
  }, [conversation?.messages.length]);

  const running = (conversation ? isBusy(conversation.messages) : false) || resolving || ownedBusy;
  const differentProvider = conversation?.providerKey !== providerKey;
  const anthropicBlocked = provider.kind === "anthropic" && !(provider.anthropic?.enabled ?? false);
  const canSend = !running && !disabled && !differentProvider && contexts.length > 0 && prompt.trim().length > 0 && !anthropicBlocked;
  // The retry action stays quiet: it appears only while idle when a previous
  // prompt exists and the trailing turn failed, was cancelled, or never
  // produced an assistant turn (e.g. staging failed with a stream error).
  const lastPrompt = conversation ? lastUserPrompt(conversation.messages) : null;
  const tailMessage = conversation?.messages[conversation.messages.length - 1];
  const tailFailed = tailMessage !== undefined && (tailMessage.role === "user"
    ? true
    : tailMessage.state === "error" || tailMessage.state === "cancelled");
  const showRetry = !running && lastPrompt !== null && (!!streamError || tailFailed);

  /** Resolve staging via prop or fallback, throwing when unresolved. */ async function resolveStaging(wanted: PromptContext[]): Promise<StagingTarget> {
    if (ensureStaging) return ensureStaging(wanted);
    if (staging) return staging;
    throw { code: "staging_unresolved", copy_id: "(未解決)" } satisfies AiError;
  }

  /** Handle one stream event gated by token, settlement, and cancel. */ function handleEvent(
    event: AiStreamEvent,
    token: number,
    targetConversationId: string,
    assistant: string,
    capturedMode: PromptMode,
  ) {
    if (!run.isCurrent(token)) return;
    if (run.isSettled(token)) return;
    if (run.isCancelRequested()) {
      if (event.type === "chunk" || event.type === "started") return;
      run.markSettled(token);
      applyToConversation(targetConversationId, (previous) => ({
        ...previous, messages: cancelAssistant(previous.messages, assistant),
      }));
      run.takeStop();
      setBusy(false);
      return;
    }
    switch (event.type) {
      case "started":
        break;
      case "chunk":
        applyToConversation(targetConversationId, (prev) => ({
          ...prev,
          messages: appendStreamingText(prev.messages, assistant, event.payload.text),
        }));
        break;
      case "done":
        run.markSettled(token);
        applyToConversation(targetConversationId, (prev) => ({
          ...prev,
          messages: finalizeAssistant(prev.messages, assistant, event.payload.proposal, event.payload.sent),
        }));
        // Stale runs never publish: only the still-active conversation
        // forwards its proposal to review.
        if (targetConversationId === activeIdRef.current) {
          onProposalRef.current?.(event.payload.proposal, event.payload.sent, capturedMode);
        }
        run.takeStop();
        setBusy(false);
        break;
      case "error":
        run.markSettled(token);
        applyToConversation(targetConversationId, (prev) => ({
          ...prev,
          messages: failAssistant(prev.messages, assistant, event.payload.error),
        }));
        run.takeStop();
        setBusy(false);
        break;
      case "cancelled":
        run.markSettled(token);
        applyToConversation(targetConversationId, (prev) => ({
          ...prev,
          messages: cancelAssistant(prev.messages, assistant),
        }));
        run.takeStop();
        setBusy(false);
        break;
    }
  }

  /** Send with staging, fencing, and late-handle settlement. */ async function sendWith(
    promptText: string,
    promptMode: PromptMode,
    promptContexts: PromptContext[],
    history: { role: "user" | "assistant"; text: string }[],
  ) {
    const trimmed = truncatePrompt(promptText).trim();
    if (trimmed === "" || promptContexts.length === 0) {
      setStreamError({ code: "staging_unresolved", copy_id: "(未解決)" });
      return;
    }
    const blockedCommand = isClaudeBlockedProvider(provider);
    if (blockedCommand !== null) {
      setStreamError(claudeRefusalError(blockedCommand));
      return;
    }
    const token = run.beginRun();
    const capturedMode = promptMode;
    const capturedContexts = promptContexts.map((context) => ({ ...context, ranges: [...context.ranges] }));
    const capturedProvider = provider;
    const targetConversationId = conversationId;
    const userMessage = createUserMessage(trimmed, capturedMode, capturedContexts);
    const assistant = { ...createStreamingAssistant(), mode: capturedMode };
    setStreamError(null);
    setResolving(true);
    setBusy(true);
    let resolved: StagingTarget;
    try {
      resolved = await resolveStaging(capturedContexts);
    } catch (cause) {
      if (!run.isCurrent(token)) { setBusy(false, token); return; }
      const failure: AiError = normalizeAiError(cause);
      setStreamError(failure);
      setResolving(false);
      setBusy(false);
      return;
    }
    // Cancel arrived while staging was pending: record the cancelled turn
    // locally and never start the run.
    if (!run.isCurrent(token)) { setBusy(false, token); return; }
    if (run.isCancelRequested()) {
      const cancelledAssistant = { ...assistant, state: "cancelled" as const };
      applyToConversation(targetConversationId, (prev) => ({
        ...prev,
        messages: [...prev.messages, userMessage, cancelledAssistant],
      }));
      setResolving(false);
      setBusy(false);
      return;
    }
    applyToConversation(targetConversationId, (prev) => ({
      ...prev,
      messages: [...prev.messages, userMessage, assistant],
    }));
    setResolving(false);
    const request: AiPromptRequest = {
      provider: capturedProvider,
      mode: capturedMode,
      prompt: trimmed,
      contexts: capturedContexts,
      staging: resolved,
      sessionId: null,
      history,
    };
    try {
      const session = await startPromptFn(request, (event) =>
        handleEvent(event, token, targetConversationId, assistant.id, capturedMode),
      );
      // Done arrived before startPrompt returned: cancel the late handle and
      // never publish a stop for a settled run, so no spinner leaks.
      if (!(await keepStartedSession(run, token, session.stop))) return;
    } catch (cause) {
      if (!run.isCurrent(token)) { setBusy(false, token); return; }
      run.markSettled(token);
      const failure = normalizeAiError(cause);
      applyToConversation(targetConversationId, (prev) => ({
        ...prev,
        messages: failAssistant(prev.messages, assistant.id, failure),
      }));
      setStreamError(failure);
      setBusy(false);
    }
  }

  /** Send the composer prompt with history when enabled. */ async function handleSend() {
    if (running || disabled || differentProvider) return;
    if (!conversation) return;
    const history = toHistoryPayload(conversation.messages);
    const sentPrompt = prompt;
    setPrompt("");
    await sendWith(sentPrompt, mode, contexts, history);
  }

  /** Request cancellation; pending paths settle as cancelled. */ async function handleCancel() {
    await run.cancelOwned();
    // No stop yet (staging/start pending): the pending path settles itself
    // as cancelled via the token/flag checks above.
  }

  /** Retry the last prompt after dropping the failed exchange. */ async function handleRetry() {
    if (running || disabled || differentProvider || !conversation) return;
    const last = lastUserPrompt(conversation.messages);
    if (!last) return;
    applyToConversation(conversation.id, (prev) => ({
      ...prev,
      messages: dropTrailingFailedExchange(prev.messages),
    }));
    const history = retryHistory(conversation.messages);
    await sendWith(last.prompt, last.mode, last.contexts, history);
  }

  /** Start a new conversation fencing the old run. */ function handleNewConversation() {
    fenceRun();
    const next = createConversation(providerKey);
    setConversations((prev) => [...prev, next]);
    setActiveId(next.id);
    setStreamError(null);
    setPrompt("");
  }

  /** Select a conversation fencing the previous run. */ function handleSelectConversation(id: string) {
    if (id === conversationId) return;
    fenceRun();
    setActiveId(id);
    setStreamError(null);
  }

  if (!conversation) return null;
  const providerSummary = panelProviderSummary(provider);

  return (
    <div aria-label="Agent チャット" className="ai-chat-panel flex h-full min-h-0 flex-col">
      <div className="ai-chat-header flex shrink-0 items-center gap-1">
        <h2 id="ai-panel-title" className="min-w-0 flex-1 truncate text-[13px] font-semibold">Agent チャット</h2>
        {conversations.length > 1 && (
          <label className="flex min-w-0 max-w-[52%] items-center gap-0.5 text-muted-foreground" title="会話の履歴">
            <History size={13} aria-hidden="true" className="shrink-0" />
            <select
              aria-label="会話の選択"
              className="ai-chat-history-select min-w-0 flex-1 truncate"
              value={conversationId}
              onChange={(event) => handleSelectConversation(event.target.value)}
            >
              {conversations.map((item, index) => (
                <option key={item.id} value={item.id}>
                  会話 {index + 1}{isBusy(item.messages) ? "（生成中）" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button variant="outline" size="sm" aria-label="新しい会話" title="新しい会話" onClick={handleNewConversation} className="ai-chat-action shrink-0 px-2">
          <Plus size={14} aria-hidden="true" />
        </Button>
        {onClose && (
          <button
            type="button"
            aria-label="Agent チャットを閉じる"
            title="閉じる"
            className="shrink-0 rounded p-1 hover:bg-muted"
            onClick={onClose}
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="ai-chat-chips flex shrink-0 flex-wrap items-center gap-1" aria-label="送信対象">
        {contexts.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">送信対象がありません。</span>
        ) : (
          contexts.map((context) => (
            <span key={context.documentId} title={`rev ${context.revision} • ${providerSummary}`} className="ai-chat-chip inline-flex max-w-full items-center gap-0.5 rounded border border-border px-1.5 py-px text-[11px] leading-5 text-muted-foreground">
              <span
                className="truncate"
              >
                {labelFor(contextLabels, context.documentId)}
              </span>
              {onRemoveContext && (
                <button
                  type="button"
                  aria-label={`${labelFor(contextLabels, context.documentId)}を外す`}
                  title="外す"
                  className="rounded px-0.5 leading-none hover:bg-muted hover:text-foreground"
                  onClick={() => onRemoveContext(context.documentId)}
                >
                  ×
                </button>
              )}
            </span>
          ))
        )}
      </div>
      <div ref={transcriptRef} aria-live="polite" aria-label="会話" className="ai-chat-transcript min-h-0 flex-1 overflow-y-auto py-1.5">
        {conversation.messages.length === 0 ? (
          <div className="ai-chat-empty px-1 py-2">
            <p className="text-xs leading-6 text-muted-foreground">文書を添えて質問や書き換えを頼めます。結果は差分確認のうえで取り込みます。</p>
            <div className="mt-2 flex flex-col gap-1.5">
              {EMPTY_EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  title="クリックで入力に入れる"
                  className="ai-chat-example rounded border border-border px-2 py-1.5 text-left text-xs leading-5 hover:bg-muted"
                  onClick={() => setPrompt(example)}
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        ) : (
          conversation.messages.map((message) =>
            message.role === "user" ? (
              <div key={message.id} className="ai-chat-message ai-chat-user border-l-2 border-primary/40 pl-2.5 text-[13px]">
                <p className="ai-chat-role text-[11px] text-muted-foreground">あなた・{MODE_LABELS[message.mode ?? mode]}</p>
                <p className="ai-chat-text mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap leading-6">{message.text}</p>
              </div>
            ) : (
              <div key={message.id} className="ai-chat-message text-[13px]">
                <p className="ai-chat-role text-[11px] text-muted-foreground">
                  AI{message.state === "streaming" ? "・生成中…" : message.state === "cancelled" ? "・取消済み" : message.state === "error" ? "・失敗" : ""}
                </p>
                {message.text && (message.state === "done"
                  ? <div className="marxen-chat-body mt-1"><MarkdownPreview text={message.text} label="AI の回答" testId={`chat-response-${message.id}`} /></div>
                  : <p className="ai-chat-text mt-0.5 whitespace-pre-wrap leading-6">{message.text}</p>)}
                {message.proposal && message.mode !== "ask" && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    変更は差分を確認して適用できます。
                  </p>
                )}
                {message.state === "error" && message.error && (
                  <p role="alert" className="mt-1 text-xs font-medium text-red-600">{describeAiError(message.error)}</p>
                )}
                {message.state === "cancelled" && <p className="mt-1 text-xs text-muted-foreground">取り消しました。</p>}
              </div>
            ),
          )
        )}
        {streamError && (
          <p role="alert" className="ai-chat-message text-xs font-medium text-red-600">{describeAiError(streamError)}</p>
        )}
        {running && (
          <p className="ai-chat-message text-[11px] text-muted-foreground">応答を生成しています…</p>
        )}
      </div>
      <div className="ai-chat-composer shrink-0 border-t border-border pt-1.5">
        <div className="ai-chat-composer-box px-1.5 pb-1.5 pt-1">
          <textarea
            aria-label="プロンプト"
            className="ai-chat-composer-input block max-h-40 min-h-14 w-full overflow-y-auto px-1 py-1 text-[13px] leading-6"
            rows={3}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="AI への指示を書きます"
          />
          <div className="mt-1 flex items-center gap-1">
            <div role="group" aria-label="プロンプトの種類" className="min-w-0 flex-1">
              <select
                aria-label="モード"
                title={`プロンプトの種類 • ${providerSummary}`}
                className="ai-chat-mode-select w-full min-w-0 truncate"
                value={mode}
                onChange={(event) => setMode(event.target.value as PromptMode)}
              >
                {MODE_ORDER.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {MODE_LABELS[candidate]}
                  </option>
                ))}
              </select>
            </div>
            <Button size="sm" aria-label="送信" title="送信" onClick={() => void handleSend()} disabled={!canSend} className="ai-chat-action shrink-0">
              <Send size={13} aria-hidden="true" />
              {running ? "送信中…" : "送信"}
            </Button>
            {running && (
              <Button variant="outline" size="sm" aria-label="取り消し" title="取り消し" onClick={() => void handleCancel()} className="ai-chat-action shrink-0">
                <Square size={12} aria-hidden="true" />
                取消
              </Button>
            )}
            {showRetry && (
              <Button variant="outline" size="sm" aria-label="再試行" title="直前の入力を再送します" onClick={() => void handleRetry()} disabled={disabled || differentProvider || lastPrompt === null} className="ai-chat-action shrink-0">
                <RotateCcw size={13} aria-hidden="true" />
                再試行
              </Button>
            )}
          </div>
        </div>
        {disabled && <p className="mt-1 text-[11px] text-muted-foreground">他の応答を生成しています。</p>}
        {differentProvider && <p className="mt-1 text-[11px] text-muted-foreground">接続先が異なる会話です。続けるには新しい会話を作成してください。</p>}
        {anthropicBlocked && <p className="mt-1 text-[11px] text-muted-foreground">Anthropic を有効化すると送信できます。</p>}
        <div className="ai-chat-settings mt-1.5">
          <AiProviderSettings provider={provider} onProvider={changeProvider} openToken={openSettingsToken} gateway={aiGateway} profileStore={profileStore} />
        </div>
      </div>
    </div>
  );
}

// Re-exported for tests that import labels from the panel module.
export type { CredentialRef };

