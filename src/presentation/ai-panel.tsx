import { sameRoot } from "../domain/document-location";
import type { LabelKey } from "../contracts/localization";
import type { Translator } from "../contracts/localization";
import { japaneseTranslator } from "../domain/localization";
import { useI18n } from "./i18n/I18nProvider";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { History, Plus, RotateCcw, Send, Square, X } from "lucide-react";
import { Button } from "./ui/button";
import { ChoiceMenu } from "./ui/choice-menu";
import { ChatHistory } from "./ai/ChatHistory";
import "./ai-chat.css";
import AiProviderSettings from "./ai-provider-settings";
import { MarkdownPreview } from "./preview/MarkdownPreview";
import {
  MODE_LABELS,
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
import { ToolCard, PlanCard, PermissionCard } from "./ai/agent-cards";
import { defaultProfile, type AiProfile } from "../domain/ai-profile";
import {
  addChatPermission,
  appendStreamingText,
  applyToolUpdate,
  cancelAssistant,
  createConversation,
  createStreamingAssistant,
  createUserMessage,
  dropTrailingFailedExchange,
  failAssistant,
  finalizeAssistant,
  isBusy,
  lastUserPrompt,
  resolveChatPermission,
  retryHistory,
  setChatPlan,
  toHistoryPayload,
  truncatePrompt,
  upsertToolCall,
  type ChatConversation,
  type ChatMessage,
  type ChatPermission,
  type ChatSegment,
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
import type { ApiConnectionControls } from "./ai/ApiConnections";

export interface AiPanelProps {
  contexts: PromptContext[];
  staging: StagingTarget | null;
  /** Always validates the exact contexts; reuses the copy only on exact match. */
  ensureStaging?: (contexts: PromptContext[]) => Promise<StagingTarget>;
  /** Controlled provider shared with inline chat; uncontrolled when absent. */
  provider?: AiProviderConfig;
  /** Replace the shared provider configuration, reporting persistence failures. */
  onProvider?: (provider: AiProviderConfig) => boolean | void;
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
  /** True when the empty scope comes from user dismissal rather than no document. */
  contextsDismissed?: boolean;
  /** Restore a dismissed send scope without touching the document. */
  onRestoreContexts?: () => void;
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
  /** Named API connection controls forwarded to the settings subview. */
  connectionControls?: ApiConnectionControls;
  /**
   * Stable connection scope fencing conversations apart from provider JSON.
   *
   * Twins sharing endpoint and model still fence runs and histories by ID.
   */
  sessionScopeKey?: string | null;
  /**
   * Optional model controls injected by the composition root.
   *
   * Rendered above the prompt box when provided; the panel never invents
   * model IDs or lists and leaves selection state to the owner.
   */
  modelControls?: ReactNode;
  /** Read-only actions placed beside the conversation and connection controls. */
  headerActions?: ReactNode;
  /** Pending-change review shown directly above the composer, as agent chats do. */
  review?: ReactNode;
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
function labelFor(labels: Record<string, string> | undefined, documentId: string, t: Translator = japaneseTranslator): string {
  return labels?.[documentId] ?? t("現在の文書");
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

/** Steps of a turn in arrival order; turns recorded before segments existed keep the old grouping. */
function stepsOf(message: ChatMessage): ChatSegment[] {
  return message.segments ?? [
    { type: "plan" },
    ...(message.tools ?? []).map((tool) => ({ type: "tool" as const, id: tool.id })),
    ...(message.permissions ?? []).map((permission) => ({ type: "permission" as const, id: permission.requestId })),
    ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
  ];
}

/** Render an assistant turn chronologically: text, plan, tool and permission steps as they arrived. */
function AssistantSteps({ message, onChoose }: {
  message: ChatMessage;
  /** Reply to a permission request with the chosen option ID. */
  onChoose: (permission: ChatPermission, optionId: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const steps = stepsOf(message);
  const lastText = steps.map((step) => step.type).lastIndexOf("text");
  return <>{steps.map((step, index) => {
    if (step.type === "plan") return message.plan && message.plan.length > 0 ? <PlanCard key="plan" entries={message.plan} /> : null;
    if (step.type === "tool") {
      const tool = message.tools?.find((item) => item.id === step.id);
      return tool ? <ToolCard key={`tool:${tool.id}`} tool={tool} /> : null;
    }
    if (step.type === "permission") {
      const permission = message.permissions?.find((item) => item.requestId === step.id);
      return permission ? <PermissionCard key={`permission:${permission.requestId}`} permission={permission} onChoose={(optionId) => onChoose(permission, optionId)} /> : null;
    }
    const testId = index === lastText ? `chat-response-${message.id}` : `chat-response-${message.id}-${index}`;
    // Write/rewrite replies are document content that lands in the file; the chat only reports it.
    if (message.mode === "generate" || message.mode === "rewrite") {
      if (index !== lastText) return null;
      return <p key={`text:${index}`} data-testid={testId} className="mt-0.5 text-xs text-muted-foreground">{message.state === "done" ? t("文書に反映しました。変更はエディターで確認できます。") : t("文書を書き換えています…")}</p>;
    }
    // shortcut: renders on every chunk (the preview keeps prior HTML, so no flicker); batch chunks if long replies feel slow.
    return <div key={`text:${index}`} className="marxen-chat-body mt-1"><MarkdownPreview text={step.text} label={t("AI の回答")} testId={testId} /></div>;
  })}</>;
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
  contextsDismissed,
  onRestoreContexts,
  onProposal,
  startPrompt: startPromptProp,
  profileStore,
  aiGateway,
  connectionControls,
  sessionScopeKey,
  modelControls,
  headerActions,
  review,
}: AiPanelProps) {
  const { t } = useI18n();
  /** Streaming transport: injected prop wins, otherwise the test fallback throws visibly. */
  const startPromptFn: AiGateway["startPrompt"] = startPromptProp
    ?? aiGateway?.startPrompt
    ?? (async () => { throw new Error("AI transport is not wired."); });
  const [saved] = useState(() => loadSavedProfile(profileStore));
  const [internal, setInternal] = useState<AiProviderConfig>(() => buildProviderConfig(saved));
  const provider = controlled ?? internal;
  const providerKey = JSON.stringify([provider, sessionScopeKey ?? null]);
  const providerKeyRef = useRef(providerKey);
  // In-memory conversation list: 新規 preserves prior conversations in the
  // selector instead of destroying them. Nothing persists to storage.
  const [conversations, setConversations] = useState<ChatConversation[]>(() => [createConversation(providerKey)]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Agents edit in an isolated copy reviewed before apply, so they start ready to work; HTTP replies are text only.
  const defaultMode: PromptMode = provider.kind === "acp" ? "workspace" : "ask";
  const [mode, setMode] = useState<PromptMode>(defaultMode);
  useEffect(() => setMode(defaultMode), [defaultMode]);
  const [historyOpen, setHistoryOpen] = useState(false);
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
    setConversations((prev) => prev.map((item) => (item.id === id ? { ...update(item), updatedAt: Date.now() } : item)));
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
    if (onProvider) {
      const ok = onProvider(next);
      if (ok === false) return;
    } else {
      setInternal(next);
    }
    moveToProvider(JSON.stringify([next, next.connectionId ?? null]));
  }

  useEffect(() => {
    if (providerKeyRef.current === providerKey) return;
    moveToProvider(providerKey);
  }, [providerKey]);

  useEffect(() => {
    if (provider.connectionId !== undefined) return;
    try {
      profileStore?.save({
        kind: provider.kind,
        preset: provider.acp?.preset ?? saved.preset,
        command: provider.acp?.argv?.command ?? saved.command,
        argsText: (provider.acp?.argv?.args ?? []).join("\n") || saved.argsText,
        endpoint: provider.openai?.endpoint ?? provider.anthropic?.endpoint ?? saved.endpoint,
        model: provider.openai?.model ?? provider.anthropic?.model ?? saved.model,
        anthropicEnabled: provider.anthropic?.enabled ?? saved.anthropicEnabled,
        acpSelections: provider.acp?.selections ?? saved.acpSelections,
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
  }, [conversation?.messages.length, conversation?.messages.at(-1)?.text.length, conversation?.messages.at(-1)?.segments?.length]);

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
    throw { code: "staging_unresolved", copy_id: t("(未解決)") } satisfies AiError;
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
    if (event.type === "usage") return;
    if (run.isCancelRequested()) {
      if (event.type === "chunk" || event.type === "started") return;
      if (event.type === "tool_call") {
        applyToConversation(targetConversationId, (previous) => ({
          ...previous, messages: upsertToolCall(previous.messages, assistant, { ...event.payload.toolCall, status: "cancelled" }),
        }));
        return;
      }
      if (event.type === "tool_call_update") return;
      if (event.type === "plan") return;
      if (event.type === "permission") {
        applyToConversation(targetConversationId, (previous) => ({
          ...previous,
          messages: addChatPermission(previous.messages, assistant, {
            requestId: event.payload.requestId,
            runId: event.payload.runId,
            toolCallId: event.payload.toolCallId,
            title: event.payload.title,
            options: event.payload.options,
          }, "cancelled"),
        }));
        return;
      }
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
      case "tool_call":
        applyToConversation(targetConversationId, (prev) => ({
          ...prev,
          messages: upsertToolCall(prev.messages, assistant, event.payload.toolCall),
        }));
        break;
      case "tool_call_update":
        applyToConversation(targetConversationId, (prev) => ({
          ...prev,
          messages: applyToolUpdate(prev.messages, assistant, event.payload.update),
        }));
        break;
      case "plan":
        applyToConversation(targetConversationId, (prev) => ({
          ...prev,
          messages: setChatPlan(prev.messages, assistant, event.payload.entries),
        }));
        break;
      case "permission":
        applyToConversation(targetConversationId, (prev) => ({
          ...prev,
          messages: addChatPermission(prev.messages, assistant, {
            requestId: event.payload.requestId,
            runId: event.payload.runId,
            toolCallId: event.payload.toolCallId,
            title: event.payload.title,
            options: event.payload.options,
          }, capturedMode === "ask" ? "denied" : "pending"),
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

  /** Send with staging, fencing, and late-handle settlement, reporting whether a turn was recorded. */ async function sendWith(
    promptText: string,
    promptMode: PromptMode,
    promptContexts: PromptContext[],
    history: { role: "user" | "assistant"; text: string }[],
  ): Promise<boolean> {
    const trimmed = truncatePrompt(promptText).trim();
    if (trimmed === "" || promptContexts.length === 0) {
      setStreamError({ code: "staging_unresolved", copy_id: t("(未解決)") });
      return false;
    }
    const blockedCommand = isClaudeBlockedProvider(provider);
    if (blockedCommand !== null) {
      setStreamError(claudeRefusalError(blockedCommand));
      return false;
    }
    const rootScope = promptContexts[0]?.location?.scope;
    if (!promptContexts.every((context) => sameRoot(context.location?.scope, rootScope)) || (conversation?.rootScope && !sameRoot(conversation.rootScope, rootScope))) {
      setStreamError({ code: "invalid_config", detail: t("既存の会話は元のフォルダーに属しています。新しいチャットを開始してください。") });
      return false;
    }
    const token = run.beginRun();
    const capturedMode = promptMode;
    const capturedContexts = promptContexts.map((context) => ({ ...context, ranges: [...context.ranges] }));
    const capturedProvider = provider;
    const targetConversationId = conversationId;
    if (rootScope) applyToConversation(targetConversationId, (previous) => ({ ...previous, rootScope }));
    const userMessage = createUserMessage(trimmed, capturedMode, capturedContexts);
    const assistant = { ...createStreamingAssistant(), mode: capturedMode };
    setStreamError(null);
    setResolving(true);
    setBusy(true);
    let resolved: StagingTarget;
    try {
      resolved = await resolveStaging(capturedContexts);
    } catch (cause) {
      if (!run.isCurrent(token)) { setBusy(false, token); return false; }
      const failure: AiError = normalizeAiError(cause, t);
      setStreamError(failure);
      setResolving(false);
      setBusy(false);
      return false;
    }
    // Cancel arrived while staging was pending: record the cancelled turn
    // locally and never start the run.
    if (!run.isCurrent(token)) { setBusy(false, token); return false; }
    if (run.isCancelRequested()) {
      const cancelledAssistant = { ...assistant, state: "cancelled" as const };
      applyToConversation(targetConversationId, (prev) => ({
        ...prev,
        messages: [...prev.messages, userMessage, cancelledAssistant],
      }));
      setResolving(false);
      setBusy(false);
      return true;
    }
    applyToConversation(targetConversationId, (prev) => ({
      ...prev,
      ...(rootScope ? { rootScope } : {}),
      messages: [...prev.messages, userMessage, assistant],
    }));
    setResolving(false);
    const request: AiPromptRequest = {
      conversationId: targetConversationId,
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
      if (!(await keepStartedSession(run, token, session.stop))) return true;
    } catch (cause) {
      if (!run.isCurrent(token)) { setBusy(false, token); return false; }
      run.markSettled(token);
      const failure = normalizeAiError(cause, t);
      applyToConversation(targetConversationId, (prev) => ({
        ...prev,
        messages: failAssistant(prev.messages, assistant.id, failure),
      }));
      setStreamError(failure);
      setBusy(false);
    }
    return true;
  }

  /** Send the composer prompt with history when enabled, keeping the draft when nothing was recorded. */ async function handleSend() {
    if (running || disabled || differentProvider) return;
    if (!conversation) return;
    if (prompt.trim() === "" || contexts.length === 0) {
      setStreamError({ code: "staging_unresolved", copy_id: t("(未解決)") });
      return;
    }
    const history = toHistoryPayload(conversation.messages);
    const sentPrompt = prompt;
    setPrompt("");
    const recorded = await sendWith(sentPrompt, mode, contexts, history);
    if (!recorded) {
      setPrompt((previous) => (previous === "" ? sentPrompt : previous));
    }
  }

  /** Request cancellation; pending paths settle as cancelled. */ async function handleCancel() {
    await run.cancelOwned();
    // No stop yet (staging/start pending): the pending path settles itself
    // as cancelled via the token/flag checks above.
  }

  /**
   * Answer one pending permission request with the exact chosen option ID.
   *
   * Replies through the injected gateway so the waiting driver delivers the
   * choice to the agent; the returned promise lets the card disable its
   * buttons while the IPC is pending. Recoverable failures set the visible
   * error first and then propagate so the card becomes retryable again.
   */
  async function handlePermissionChoice(messageId: string, runId: string, requestId: string, optionId: string) {
    try {
      const reply = aiGateway?.replyPermission;
      if (!reply) throw new Error("AI transport is not wired.");
      await reply(runId, requestId, optionId);
      const target = conversationId;
      if (!target) return;
      applyToConversation(target, (prev) => ({
        ...prev,
        messages: resolveChatPermission(prev.messages, messageId, requestId, optionId),
      }));
    } catch (cause) {
      setStreamError(normalizeAiError(cause, t));
      throw cause;
    }
  }

  /** Retry the last prompt after dropping the failed exchange. */ async function handleRetry() {    if (running || disabled || differentProvider || !conversation) return;
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
    setHistoryOpen(false);
  }

  /** Select a conversation fencing the previous run. */ function handleSelectConversation(id: string) {
    if (id === conversationId) return;
    const previousActiveId = conversationId;
    const previousKey = providerKeyRef.current;
    fenceRun();
    setActiveId(id);
    setStreamError(null);
    const key = conversations.find((item) => item.id === id)?.providerKey;
    if (key && key !== providerKey) {
      const [previousProvider] = JSON.parse(key) as [AiProviderConfig, unknown];
      if (onProvider) {
        const ok = onProvider(previousProvider);
        if (ok === false) {
          setActiveId(previousActiveId);
          providerKeyRef.current = previousKey;
          return;
        }
      } else {
        setInternal(previousProvider);
      }
      providerKeyRef.current = key;
    }
  }

  if (!conversation) return null;

  return (
    <div aria-label={t("チャット")} className="ai-chat-panel flex h-full min-h-0 flex-col">
      <div className="ai-chat-header flex shrink-0 items-center gap-1">
        <h2 id="ai-panel-title" className="min-w-0 flex-1 truncate text-[13px] font-medium">{historyOpen ? t("チャットの履歴") : t("チャット")}</h2>
        {headerActions}
        <AiProviderSettings compact provider={provider} onProvider={changeProvider} openToken={openSettingsToken} gateway={aiGateway} profileStore={profileStore} connectionControls={connectionControls} />
        <button type="button" aria-label={historyOpen ? t("チャットに戻る") : t("履歴を開く")} aria-pressed={historyOpen} title={historyOpen ? t("チャットに戻る") : t("チャットの履歴")} className="rounded-sm p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setHistoryOpen((value) => !value)}><History size={15} aria-hidden="true" /></button>
        <button type="button" aria-label={t("新しい会話")} title={t("新しいチャット")} onClick={handleNewConversation} className="shrink-0 rounded-sm p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
          <Plus size={14} aria-hidden="true" />
        </button>
        {onClose && (
          <button
            type="button"
            aria-label={t("チャットを閉じる")}
            title={t("閉じる")}
            className="shrink-0 rounded p-1 hover:bg-muted"
            onClick={onClose}
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      {historyOpen ? <ChatHistory conversations={conversations} activeId={conversationId} onSelect={(id) => { handleSelectConversation(id); setHistoryOpen(false); }} /> : <>
      <div className="ai-chat-chips flex shrink-0 flex-wrap items-center gap-1" aria-label={t("送信対象")}>
        {contexts.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">{t("送信対象がありません。")}</span>
        ) : (
          contexts.map((context) => (
            <span key={context.documentId} className="ai-chat-chip inline-flex max-w-full items-center gap-0.5 rounded border border-border px-1.5 py-px text-[11px] leading-5 text-muted-foreground">
              <span
                className="truncate"
              >
                {labelFor(contextLabels, context.documentId, t)}
              </span>
              {onRemoveContext && (
                <button
                  type="button"
                  aria-label={t("{{value0}}を外す", { value0: (labelFor(contextLabels, context.documentId, t)) })}
                  title={t("外す")}
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
      <div ref={transcriptRef} aria-live="polite" aria-label={t("会話")} className="ai-chat-transcript min-h-0 flex-1 overflow-y-auto py-1.5">
        {conversation.messages.length === 0 ? (
          <div className="ai-chat-empty px-1 py-2">
            <div className="flex flex-col gap-1.5">
              {EMPTY_EXAMPLES.map((exampleKey) => { const example = t(exampleKey as LabelKey); return (
                <button
                  key={example}
                  type="button"
                  title={t("クリックで入力に入れる")}
                  className="ai-chat-example rounded border border-border px-2 py-1.5 text-left text-xs leading-5 hover:bg-muted"
                  onClick={() => setPrompt(example)}
                >
                  {example}
                </button>
              ); })}
            </div>
          </div>
        ) : (
          conversation.messages.map((message) =>
            message.role === "user" ? (
              <div key={message.id} className="ai-chat-message ai-chat-user border-l-2 border-primary/40 pl-2.5 text-[13px]">
                <p className="ai-chat-role text-[11px] text-muted-foreground">{t("あなた・")}{t(MODE_LABELS[message.mode ?? mode] as LabelKey)}</p>
                <p className="ai-chat-text mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap leading-6">{message.text}</p>
              </div>
            ) : (
              <div key={message.id} className="ai-chat-message text-[13px]">
                <p className="ai-chat-role text-[11px] text-muted-foreground">
                  AI{message.state === "streaming" ? t("・生成中…") : message.state === "cancelled" ? t("・取消済み") : message.state === "error" ? t("・失敗") : ""}
                </p>
                <AssistantSteps message={message} onChoose={(permission, optionId) => handlePermissionChoice(message.id, permission.runId, permission.requestId, optionId)} />
                {message.state === "error" && message.error && (
                  <p role="alert" className="mt-1 text-xs font-medium text-red-600">{describeAiError(message.error, t)}</p>
                )}
                {message.state === "cancelled" && <p className="mt-1 text-xs text-muted-foreground">{t("取り消しました。")}</p>}
              </div>
            ),
          )
        )}
        {streamError && (
          <p role="alert" className="ai-chat-message text-xs font-medium text-red-600">{describeAiError(streamError, t)}</p>
        )}
        {running && (
          <p className="ai-chat-message text-[11px] text-muted-foreground">{t("応答を生成しています…")}</p>
        )}
      </div>
      {review && <div className="max-h-72 min-h-0 shrink-0 overflow-y-auto">{review}</div>}
      <div className="ai-chat-composer shrink-0 border-t border-border pt-1.5">
        <div className="ai-chat-composer-box px-1.5 pb-1.5 pt-1">
          <textarea
            aria-label={t("プロンプト")}
            className="ai-chat-composer-input block max-h-40 min-h-14 w-full overflow-y-auto px-1 py-1 text-[13px] leading-6"
            rows={3}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line; IME confirmation Enter never sends.
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
              event.preventDefault();
              if (canSend) void handleSend();
            }}
            placeholder={t("AI への指示を書きます（Enter で送信、Shift+Enter で改行）")}
          />
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <div role="group" aria-label={t("プロンプトの種類")} className="min-w-0 shrink-0">
              <ChoiceMenu label={t("モード")} value={mode} onChange={(value) => setMode(value as PromptMode)} disabled={running || disabled} choices={MODE_ORDER.map((value) => ({ value, label: t(MODE_LABELS[value] as LabelKey) }))} />
            </div>
            {modelControls && <div className="ai-chat-model-slot min-w-0 flex-1 empty:hidden">{modelControls}</div>}
            <Button size="sm" aria-label={t("送信")} title={t("送信")} onClick={() => void handleSend()} disabled={!canSend} className="ai-chat-action shrink-0">
              <Send size={13} aria-hidden="true" />
              {running ? t("送信中…") : t("送信")}
            </Button>
            {running && (
              <Button variant="outline" size="sm" aria-label={t("取り消し")} title={t("取り消し")} onClick={() => void handleCancel()} className="ai-chat-action shrink-0">
                <Square size={12} aria-hidden="true" />
                {t("取消")}</Button>
            )}
            {showRetry && (
              <Button variant="outline" size="sm" aria-label={t("再試行")} title={t("直前の入力を再送します")} onClick={() => void handleRetry()} disabled={disabled || differentProvider || lastPrompt === null} className="ai-chat-action shrink-0">
                <RotateCcw size={13} aria-hidden="true" />
                {t("再試行")}</Button>
            )}
          </div>
        </div>
        {disabled && <p className="mt-1 text-[11px] text-muted-foreground">{t("他の応答を生成しています。")}</p>}
        {differentProvider && <p className="mt-1 text-[11px] text-muted-foreground">{t("接続先が異なる会話です。続けるには新しい会話を作成してください。")}</p>}
        {anthropicBlocked && <p className="mt-1 text-[11px] text-muted-foreground">{t("Anthropic を有効化すると送信できます。")}</p>}
        {contexts.length === 0 && !running && !disabled && !differentProvider && !anthropicBlocked && (
          <p data-testid="ai-composer-empty-hint" className="mt-1 text-[11px] text-muted-foreground">
            {t("送信対象がありません。")}
            {contextsDismissed && onRestoreContexts && (
              <button type="button" onClick={onRestoreContexts} className="ml-1 underline hover:text-foreground">
                {t("現在の選択を送る")}
              </button>
            )}
          </p>
        )}
      </div>
      </>}
    </div>
  );
}

// Re-exported for tests that import labels from the panel module.
export type { CredentialRef };

