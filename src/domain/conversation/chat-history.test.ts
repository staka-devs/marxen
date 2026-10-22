import { describe, expect, it } from "vitest";
import { MAX_STORED_CONVERSATIONS, restoredConversations, storedConversations } from "./chat-history";
import type { ChatConversation } from "./ai-conversation";

/** One conversation with a finished turn and an excerpt that must not be stored. */
function conversation(id: string, updatedAt: number): ChatConversation {
  return {
    id, providerKey: "p", createdAt: 1, updatedAt, rootScope: { rootId: "r", generation: "1" },
    messages: [
      { id: `${id}-u`, role: "user", text: "質問", state: "done", mode: "ask", contexts: [{ documentId: "d", revision: 1, ranges: [], text: "secret excerpt" }] },
      { id: `${id}-a`, role: "assistant", text: "回答", state: "done", proposal: { text: "回答", baseContexts: [] }, sent: [] },
    ],
  };
}

describe("chat history storage", () => {
  it("keeps finished turns and drops excerpts, proposals, scope and streaming turns", () => {
    const busy = { ...conversation("b", 5), messages: [{ id: "s", role: "assistant" as const, text: "途中", state: "streaming" as const }] };
    const stored = storedConversations([conversation("a", 3), busy]);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain("secret excerpt");
    expect(stored[0]).not.toHaveProperty("rootScope");
    expect(stored[0].messages[1]).not.toHaveProperty("proposal");
  });

  it("keeps the newest conversations within the count cap", () => {
    const many = Array.from({ length: MAX_STORED_CONVERSATIONS + 5 }, (_, index) => conversation(`c${index}`, index));
    const stored = storedConversations(many);
    expect(stored).toHaveLength(MAX_STORED_CONVERSATIONS);
    expect(stored[0].id).toBe(`c${MAX_STORED_CONVERSATIONS + 4}`);
  });

  it("round-trips through JSON and skips malformed entries", () => {
    const stored = JSON.parse(JSON.stringify(storedConversations([conversation("a", 3)])));
    expect(restoredConversations([...stored, null, { id: 1 }, { id: "x", createdAt: 1, updatedAt: 1, messages: [{ role: "bot" }] }])).toEqual(stored);
    expect(restoredConversations("broken")).toEqual([]);
  });
});
