// What of the chat survives a restart (domain, Issue #128).
//
// Only finished turns with their visible text and progress cards are kept.
// Document excerpts (contexts), proposals, permission choices and folder scope
// stay in memory: they hold document text or bind to one app session.

import type { ChatConversation, ChatMessage } from "./ai-conversation";

/** Newest conversations kept on disk. */
export const MAX_STORED_CONVERSATIONS = 50;
/** Total stored JSON size; oldest conversations are dropped beyond it. */
export const MAX_STORED_CHARS = 2_000_000;

const STATES = new Set(["done", "error", "cancelled"]);

/** Keep one message's display fields, or drop it while it is still streaming. */
function storedMessage(message: ChatMessage): ChatMessage | null {
  if (!STATES.has(message.state)) return null;
  const { id, role, text, state, mode, tools, plan, segments } = message;
  return { id, role, text, state, ...(mode ? { mode } : {}), ...(tools ? { tools } : {}), ...(plan ? { plan } : {}), ...(segments ? { segments } : {}) };
}

/** Conversations to persist: finished turns only, newest first, within the count and size caps. */
export function storedConversations(conversations: ChatConversation[]): ChatConversation[] {
  const stored = conversations
    .map(({ id, providerKey, createdAt, updatedAt, messages }) => ({ id, providerKey, createdAt, updatedAt, messages: messages.flatMap((message) => storedMessage(message) ?? []) }))
    .filter((conversation) => conversation.messages.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_STORED_CONVERSATIONS);
  while (stored.length > 0 && JSON.stringify(stored).length > MAX_STORED_CHARS) stored.pop();
  return stored;
}

/** Read stored conversations back, skipping anything malformed instead of failing the panel. */
export function restoredConversations(value: unknown): ChatConversation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ChatConversation[] => {
    if (!item || typeof item !== "object") return [];
    const { id, providerKey, createdAt, updatedAt, messages } = item as Record<string, unknown>;
    if (typeof id !== "string" || typeof createdAt !== "number" || typeof updatedAt !== "number" || !Array.isArray(messages)) return [];
    const valid = messages.filter((message): message is ChatMessage => !!message && typeof message === "object"
      && typeof (message as ChatMessage).id === "string" && ((message as ChatMessage).role === "user" || (message as ChatMessage).role === "assistant")
      && typeof (message as ChatMessage).text === "string" && STATES.has((message as ChatMessage).state));
    return valid.length > 0 ? [{ id, createdAt, updatedAt, messages: valid, ...(typeof providerKey === "string" ? { providerKey } : {}) }] : [];
  });
}
