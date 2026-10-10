// Agent / inline conversation state. UI-only: history sent to Rust is the
// explicit bounded `history` array on AiPromptRequest, validated there.
// Cancelled or failed turns never persist into the next request.

import type {
  AiError,
  ChatHistoryMessage,
  ContextSummary,
  ProposalText,
  PromptContext,
  PromptMode,
} from "../../contracts/ai-contracts";

export const MAX_HISTORY_TURNS = 32;
export const MAX_PROMPT_CHARS = 20_000;

export type ChatMessageState = "streaming" | "done" | "error" | "cancelled";

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
}

export interface ChatConversation {
  id: string;
  messages: ChatMessage[];
  providerKey?: string;
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
  return { id: `conv_${Date.now()}_${conversationSeq}`, messages: [], providerKey };
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
  return { id: `msg_${Date.now()}_${messageSeq}`, role: "assistant", text: "", state: "streaming" };
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
 */
export function cancelAssistant(messages: ChatMessage[], assistantId: string): ChatMessage[] {
  return messages.map((message) =>
    message.id === assistantId ? { ...message, state: "cancelled" as const } : message,
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
