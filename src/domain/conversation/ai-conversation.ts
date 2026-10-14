import type { Translator } from "../../contracts/localization";
import { japaneseTranslator } from "../localization";
// Agent / inline conversation state. UI-only: history sent to Rust is the
// explicit bounded `history` array on AiPromptRequest, validated there.
// Cancelled or failed turns never persist into the next request.

import type {
  AiError,
  AcpToolCall,
  AcpToolCallUpdate,
  ChatHistoryMessage,
  ContextSummary,
  PermissionOption,
  PlanEntry,
  ProposalText,
  PromptContext,
  PromptMode,
} from "../../contracts/ai-contracts";

export const MAX_HISTORY_TURNS = 32;
export const MAX_PROMPT_CHARS = 20_000;

export type ChatMessageState = "streaming" | "done" | "error" | "cancelled";

/** Visible tool progress for one agent tool call in chat. */
export interface ChatTool {
  id: string;
  title: string;
  kind: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  locations?: Array<{ path: string; line?: number }>;
}

/** Surfaced permission request with actual user-choosable options. */
export interface ChatPermission {
  requestId: string;
  runId: string;
  toolCallId?: string;
  title: string;
  options: PermissionOption[];
  /** Pending until the user chooses or the run settles; never auto-resolved. */
  state: "pending" | "resolved" | "denied" | "cancelled";
  /** The exact option the user chose; present only when resolved. */
  resolvedOptionId?: string;
  /** Buttons act on the live run; false in read-only Ask turns. */
  interactive: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  state: ChatMessageState;
  mode?: PromptMode;
  /** Exact contexts captured for this user turn. */
  contexts?: PromptContext[];
  proposal?: ProposalText | null;
  sent?: ContextSummary[];
  error?: AiError | null;
  /** Real tool progress in arrival order; never fabricated for HTTP backends. */
  tools?: ChatTool[];
  /** Latest complete execution plan; replaced on every plan event. */
  plan?: PlanEntry[];
  /** Surfaced permission requests with actual option IDs. */
  permissions?: ChatPermission[];
}

export interface ChatConversation {
  id: string;
  messages: ChatMessage[];
  providerKey?: string;
  createdAt: number;
  updatedAt: number;
}

let conversationSeq = 0;
let messageSeq = 0;

/**
 * Create an empty conversation bound to a provider key for history scoping.
 *
 * IDs combine timestamp and sequence so concurrent chats never collide.
 */
export function createConversation(providerKey?: string): ChatConversation {
  conversationSeq += 1;
  const now = Date.now();
  return { id: `conv_${now}_${conversationSeq}`, messages: [], providerKey, createdAt: now, updatedAt: now };
}

/** Identify a conversation by its first request without exposing internal identifiers. */
export function conversationTitle(conversation: ChatConversation, t: Translator = japaneseTranslator): string {
  const prompt = conversation.messages.find((message) => message.role === "user")?.text.trim().replace(/\s+/g, " ");
  if (!prompt) return t("新しいチャット");
  const characters = Array.from(prompt);
  return characters.slice(0, 48).join("") + (characters.length > 48 ? "…" : "");
}

/**
 * Create a done user message capturing exact contexts for authorization.
 *
 * Contexts are cloned so later selection moves cannot mutate the sent scope.
 */
export function createUserMessage(prompt: string, mode: PromptMode, contexts: PromptContext[]): ChatMessage {
  messageSeq += 1;
  return {
    id: `msg_${Date.now()}_${messageSeq}`,
    role: "user",
    text: prompt,
    state: "done",
    mode,
    contexts: contexts.map((context) => ({ ...context })),
  };
}

/**
 * Create an empty streaming assistant placeholder for a new turn.
 *
 * Chunks append via `appendStreamingText` until finalize/fail/cancel settles it.
 */
export function createStreamingAssistant(): ChatMessage {
  messageSeq += 1;
  return { id: `msg_${Date.now()}_${messageSeq}`, role: "assistant", text: "", state: "streaming", tools: [], plan: [], permissions: [] };
}

/**
 * Upsert one announced tool call by ID, preserving arrival order.
 *
 * New IDs append; existing IDs replace title/kind/status/locations so
 * lifecycle ordering stays visible without fabricating a timeline.
 */
export function upsertToolCall(messages: ChatMessage[], assistantId: string, tool: AcpToolCall): ChatMessage[] {
  return messages.map((message) => {
    if (message.id !== assistantId || message.role !== "assistant") return message;
    const tools = [...(message.tools ?? [])];
    const record: ChatTool = {
      id: tool.toolCallId,
      title: tool.title,
      kind: tool.kind,
      status: tool.status,
      locations: tool.locations?.map((location) => ({ ...location })),
    };
    const index = tools.findIndex((item) => item.id === record.id);
    if (index >= 0) tools[index] = { ...tools[index], ...record };
    else tools.push(record);
    return { ...message, tools };
  });
}

/**
 * Apply one tool-call patch by ID, leaving unknown IDs untouched.
 *
 * Only supplied fields change; absent fields keep prior values so partial
 * updates never clear progress. Wrong-session updates never reach here.
 */
export function applyToolUpdate(messages: ChatMessage[], assistantId: string, update: AcpToolCallUpdate): ChatMessage[] {
  return messages.map((message) => {
    if (message.id !== assistantId || message.role !== "assistant") return message;
    const tools = (message.tools ?? []).map((tool) => {
      if (tool.id !== update.toolCallId) return tool;
      return {
        ...tool,
        title: update.title ?? tool.title,
        kind: update.kind ?? tool.kind,
        status: update.status ?? tool.status,
        locations: update.locations ? update.locations.map((location) => ({ ...location })) : tool.locations,
      };
    });
    return { ...message, tools };
  });
}

/**
 * Replace the execution plan with the latest complete entry list.
 *
 * Plans always carry every entry; clients never merge partial plans.
 */
export function setChatPlan(messages: ChatMessage[], assistantId: string, entries: PlanEntry[]): ChatMessage[] {
  return messages.map((message) =>
    message.id === assistantId && message.role === "assistant"
      ? { ...message, plan: entries.map((entry) => ({ ...entry })) }
      : message,
  );
}

/**
 * Surface one permission request with its actual options for chat display.
 *
 * Normal turns arrive pending with actionable buttons; the choice travels to
 * Rust by exact run/request/option IDs. Read-only Ask turns arrive denied
 * with disabled buttons because the driver refuses without waiting.
 * Cancelled arrivals settle as cancelled. Nothing auto-resolves a pending
 * interactive request.
 */
export function addChatPermission(
  messages: ChatMessage[],
  assistantId: string,
  permission: { requestId: string; runId: string; toolCallId?: string; title: string; options: PermissionOption[] },
  mode: "pending" | "denied" | "cancelled",
): ChatMessage[] {
  return messages.map((message) => {
    if (message.id !== assistantId || message.role !== "assistant") return message;
    const permissions = [...(message.permissions ?? [])];
    if (permissions.some((item) => item.requestId === permission.requestId)) return message;
    permissions.push({
      requestId: permission.requestId,
      runId: permission.runId,
      toolCallId: permission.toolCallId,
      title: permission.title,
      options: permission.options.map((option) => ({ ...option })),
      state: mode,
      interactive: mode === "pending",
    });
    return { ...message, permissions };
  });
}

/**
 * Resolve one pending permission with the exact option the user chose.
 *
 * Unknown request IDs leave the transcript untouched so stale replies never
 * mark another request.
 */
export function resolveChatPermission(
  messages: ChatMessage[],
  assistantId: string,
  requestId: string,
  optionId: string,
): ChatMessage[] {
  return messages.map((message) => {
    if (message.id !== assistantId || message.role !== "assistant") return message;
    const permissions = (message.permissions ?? []).map((item) =>
      item.requestId !== requestId || item.state !== "pending"
        ? item
        : { ...item, state: "resolved" as const, resolvedOptionId: optionId, interactive: false },
    );
    return { ...message, permissions };
  });
}

/**
 * Settle every pending permission as cancelled for a cancelled assistant turn.
 *
 * Mirrors the tool rule: cancellation ends every unsettled choice exactly
 * once per turn.
 */
export function cancelChatPermissions(messages: ChatMessage[], assistantId: string): ChatMessage[] {
  return messages.map((message) => {
    if (message.id !== assistantId || message.role !== "assistant") return message;
    const permissions = (message.permissions ?? []).map((item) =>
      item.state === "pending" ? { ...item, state: "cancelled" as const, interactive: false } : item,
    );
    return { ...message, permissions };
  });
}

/**
 * Mark every non-terminal tool as cancelled for a cancelled assistant turn.
 *
 * Mirrors the official prompt-turn rule: clients preemptively settle
 * unfinished tools when cancellation is sent, exactly once per turn.
 */
export function cancelChatTools(messages: ChatMessage[], assistantId: string): ChatMessage[] {
  return messages.map((message) => {
    if (message.id !== assistantId || message.role !== "assistant") return message;
    const tools = (message.tools ?? []).map((tool) =>
      tool.status === "pending" || tool.status === "in_progress"
        ? { ...tool, status: "cancelled" as const }
        : tool,
    );
    return { ...message, tools };
  });
}

/** Only completed turns become Rust-validated history, oldest first. */
export function toHistoryPayload(messages: ChatMessage[]): ChatHistoryMessage[] {
  const history: ChatHistoryMessage[] = [];
  for (let index = 0; index + 1 < messages.length; index += 1) {
    const user = messages[index];
    const assistant = messages[index + 1];
    if (user.role !== "user" || assistant.role !== "assistant" ||
        user.state !== "done" || assistant.state !== "done" ||
        !user.text.trim() || !assistant.text.trim()) continue;
    history.push(
      { role: "user", text: user.text.slice(0, MAX_PROMPT_CHARS) },
      { role: "assistant", text: assistant.text.slice(0, MAX_PROMPT_CHARS) },
    );
    index += 1;
  }
  return history.slice(-MAX_HISTORY_TURNS);
}

/**
 * Return the last done user turn with its prompt, mode, and contexts.
 *
 * Used for retry so the same scope resends without duplicating the turn.
 */
export function lastUserPrompt(messages: ChatMessage[]): { prompt: string; mode: PromptMode; contexts: PromptContext[] } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" && message.state === "done") {
      return { prompt: message.text, mode: message.mode ?? "ask", contexts: message.contexts ?? [] };
    }
  }
  return null;
}

/** History that precedes the last done user turn: the retry payload. */
export function retryHistory(messages: ChatMessage[]): ChatHistoryMessage[] {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user" && messages[index].state === "done") {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) return [];
  return toHistoryPayload(messages.slice(0, lastUserIndex));
}

/**
 * Append a stream chunk to the streaming assistant by ID, preserving others.
 *
 * Pure update so late chunks for fenced runs can be dropped by the caller.
 */
export function appendStreamingText(messages: ChatMessage[], assistantId: string, chunk: string): ChatMessage[] {
  return messages.map((message) =>
    message.id === assistantId && message.role === "assistant"
      ? { ...message, text: message.text + chunk }
      : message,
  );
}

/**
 * Finalize a streaming assistant into a done proposal with sent scope.
 *
 * Text becomes the proposal text; history eligibility starts here.
 */
export function finalizeAssistant(
  messages: ChatMessage[],
  assistantId: string,
  proposal: ProposalText,
  sent: ContextSummary[],
): ChatMessage[] {
  return messages.map((message) =>
    message.id === assistantId
      ? { ...message, text: proposal.text, state: "done" as const, proposal, sent, error: null }
      : message,
  );
}

/**
 * Mark a streaming assistant as failed with the wire error, preserving text.
 *
 * Failed turns never enter history; retry drops the trailing exchange first.
 */
export function failAssistant(messages: ChatMessage[], assistantId: string, error: AiError): ChatMessage[] {
  return messages.map((message) =>
    message.id === assistantId ? { ...message, state: "error" as const, error } : message,
  );
}

/**
 * Mark a streaming assistant as cancelled without persisting the turn.
 *
 * Cancelled exchanges drop from history so the next request stays clean.
 * Unfinished tools and pending permissions settle as cancelled exactly once.
 */
export function cancelAssistant(messages: ChatMessage[], assistantId: string): ChatMessage[] {
  return cancelChatPermissions(
    cancelChatTools(
      messages.map((message) =>
        message.id === assistantId ? { ...message, state: "cancelled" as const } : message,
      ),
      assistantId,
    ),
    assistantId,
  );
}

/** Drop the trailing failed exchange so cancel/error never leaks into history. */
export function dropTrailingFailedExchange(messages: ChatMessage[]): ChatMessage[] {
  const next = [...messages];
  const last = next[next.length - 1];
  if (!last || last.role !== "assistant") return next;
  if (last.state === "done") return next;
  next.pop();
  if (next.at(-1)?.role === "user") next.pop();
  return next;
}

/**
 * Check whether any assistant turn is still streaming for spinners.
 *
 * True while chunks may still arrive; fence logic clears on settle.
 */
export function isBusy(messages: ChatMessage[]): boolean {
  return messages.some((message) => message.role === "assistant" && message.state === "streaming");
}

/**
 * Truncate a prompt to the bounded history length for wire safety.
 *
 * Rust validates bounds, but truncation here keeps payloads predictable.
 */
export function truncatePrompt(prompt: string): string {
  return prompt.slice(0, MAX_PROMPT_CHARS);
}
