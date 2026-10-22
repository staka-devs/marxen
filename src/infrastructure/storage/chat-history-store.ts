import type { ChatHistoryStore } from "../../application/ports";
import { restoredConversations, storedConversations } from "../../domain/conversation/chat-history";

const KEY = "marxen.chat-history.v1";

/** Persist finished chat turns in local storage, tolerating missing, corrupt or full storage. */
export const chatHistoryStore: ChatHistoryStore = {
  /** Read stored conversations, skipping anything malformed. */
  load: () => {
    try { return restoredConversations(JSON.parse(localStorage.getItem(KEY) ?? "null")); }
    catch { return []; }
  },
  /** Write only the storable part (no document excerpts, proposals or scope). */
  save: (conversations) => {
    try { localStorage.setItem(KEY, JSON.stringify(storedConversations(conversations))); return true; }
    catch { return false; }
  },
};
