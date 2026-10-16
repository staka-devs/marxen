import { describe, expect, it } from "vitest";
import { buildProviderConfigFromConnection, defaultConnectionList, findConnectionForProvider, isApiProtocol, isConnectionId, isConnectionName, isConnectionStorageCorrupted, pickConnectionId, resolveProviderChange, sanitizeApiConnection, sanitizeApiConnectionList, validateConnectionFields } from "./ai-connections";
import { defaultProviderConfig } from "./ai-config";
import type { ApiConnection } from "../contracts/ai-contracts";

/** Build one valid connection fixture with overridable fields. */
function connection(overrides: Partial<ApiConnection> = {}): ApiConnection {
  return { id: "api-fixture", name: "本番", protocol: "openai_chat_completions", endpoint: "https://api.example.com/v1", model: "model-x", ...overrides };
}

describe("named API connection rules", () => {
  it("sanitizes one connection and drops unrecoverable entries", () => {
    expect(sanitizeApiConnection(connection())).toEqual(connection());
    expect(sanitizeApiConnection({ ...connection(), name: "  開発  " })?.name).toBe("開発");
    expect(sanitizeApiConnection({ ...connection(), id: "bad id" })).toBeNull();
    expect(sanitizeApiConnection({ ...connection(), protocol: "acp" })).toBeNull();
    expect(sanitizeApiConnection({ ...connection(), name: "" })).toBeNull();
    expect(sanitizeApiConnection({ ...connection(), endpoint: "" })).toBeNull();
    expect(sanitizeApiConnection(null)).toBeNull();
    expect(isConnectionId("api-1")).toBe(true);
    expect(isConnectionId("")).toBe(false);
    expect(isConnectionName("  a  ")).toBe(true);
    expect(isConnectionName("   ")).toBe(false);
    expect(isApiProtocol("anthropic")).toBe(true);
    expect(isApiProtocol("acp")).toBe(false);
  });
  it("sanitizes stored lists, dedupes IDs, and repairs the active selection", () => {
    expect(sanitizeApiConnectionList(null)).toEqual(defaultConnectionList());
    expect(sanitizeApiConnectionList("broken")).toEqual({ ...defaultConnectionList(), initialized: true });
    expect(sanitizeApiConnectionList({ version: 2, connections: [connection({ id: "api-9" })] })).toEqual({ version: 1, activeId: "api-9", connections: [connection({ id: "api-9" })], initialized: true });
    const first = connection({ id: "api-1" });
    const second = connection({ id: "api-2", protocol: "anthropic" });
    const list = sanitizeApiConnectionList({ version: 1, activeId: "api-2", connections: [first, { ...first }, { ...second, protocol: "nope" }, second], initialized: true });
    expect(list.connections).toEqual([first, second]);
    expect(list.activeId).toBe("api-2");
    expect(list.initialized).toBe(true);
    const repaired = sanitizeApiConnectionList({ version: 1, activeId: "api-gone", connections: [first] });
    expect(repaired.activeId).toBe("api-1");
    expect(repaired.initialized).toBe(true);
    const legacyEmpty = sanitizeApiConnectionList({ version: 1, activeId: null, connections: [] });
    expect(legacyEmpty).toEqual({ version: 1, activeId: null, connections: [], initialized: true });
    expect(sanitizeApiConnectionList({ version: 1, activeId: null, connections: [] }).activeId).toBeNull();
  });
  it("preserves an explicit null selection through save and load round-trips", () => {
    const first = connection({ id: "api-1" });
    const second = connection({ id: "api-2" });
    const cleared = sanitizeApiConnectionList({ version: 1, activeId: null, connections: [first, second], initialized: true });
    expect(cleared.activeId).toBeNull();
    expect(cleared.connections).toEqual([first, second]);
    const undefinedRepairs = sanitizeApiConnectionList({ version: 1, connections: [first, second] });
    expect(undefinedRepairs.activeId).toBe("api-1");
  });
  it("picks deterministic IDs, skipping invalid and colliding candidates", () => {
    expect(pickConnectionId([], ["api-a", "api-b"])).toBe("api-a");
    expect(pickConnectionId(["api-a"], ["api-a", "bad id", "api-b"])).toBe("api-b");
    expect(pickConnectionId(["api-0", "api-1"], [])).toBe("api-2");
    expect(isConnectionId(pickConnectionId([], []))).toBe(true);
  });
  it("validates dialog input per field without inventing defaults", () => {
    expect(validateConnectionFields({ name: "開発", protocol: "anthropic", endpoint: "https://api.example.com/v1", model: "m" })).toEqual([]);
    expect(validateConnectionFields({ name: "", protocol: "anthropic", endpoint: "https://api.example.com/v1", model: "" })).toContain("接続先名は 1〜64 文字で指定します");
    expect(validateConnectionFields({ name: "a", protocol: "acp", endpoint: "https://api.example.com/v1", model: "" })).toContain("通信形式を選びます。");
    expect(validateConnectionFields({ name: "a", protocol: "openai_chat_completions", endpoint: "ftp://x", model: "" })).toContain("endpoint は http:// または https:// です");
    expect(validateConnectionFields({ name: "a", protocol: "openai_chat_completions", endpoint: "https://user@host/v1", model: "" })).toContain("endpoint は http:// または https:// です");
  });
  it("maps connections to wire configs and matches providers back without mixing", () => {
    const openai = connection();
    const config = buildProviderConfigFromConnection(openai);
    expect(config).toEqual({ kind: "openai_chat_completions", acp: null, openai: { endpoint: "https://api.example.com/v1", model: "model-x" }, anthropic: null, connectionId: "api-fixture" });
    const anthropic = connection({ id: "api-2", protocol: "anthropic" });
    const second = buildProviderConfigFromConnection(anthropic);
    expect(second.anthropic).toMatchObject({ enabled: true, model: "model-x" });
    const list = sanitizeApiConnectionList({ version: 1, activeId: "api-fixture", connections: [openai, anthropic], initialized: true });
    expect(findConnectionForProvider(list, config)?.id).toBe("api-fixture");
    expect(findConnectionForProvider(list, second)?.id).toBe("api-2");
    expect(findConnectionForProvider(list, { kind: "acp", acp: { preset: "codex", argv: null }, openai: null, anthropic: null })).toBeNull();
    expect(findConnectionForProvider(list, { ...config, openai: { endpoint: "https://other.example.com/v1", model: "model-x" } })).toBeNull();
  });
  it("flags corrupt storage for retention while missing keys stay migration-eligible", () => {
    expect(isConnectionStorageCorrupted(null)).toBe(false);
    expect(isConnectionStorageCorrupted(undefined)).toBe(false);
    expect(isConnectionStorageCorrupted("{broken")).toBe(true);
    expect(isConnectionStorageCorrupted({ version: 1, activeId: null, connections: [] })).toBe(false);
    expect(isConnectionStorageCorrupted({ version: 2, activeId: "api-9", connections: [connection({ id: "api-9" })] })).toBe(true);
    expect(isConnectionStorageCorrupted({ version: 1, activeId: null, connections: [{ ...connection(), id: "bad id" }] })).toBe(true);
    expect(isConnectionStorageCorrupted({ version: 1, activeId: null, connections: [connection({ id: "api-1" }), connection({ id: "api-1" })] })).toBe(true);
    expect(isConnectionStorageCorrupted({ version: 1, activeId: "api-gone", connections: [] })).toBe(true);
  });
  it("clears the named marker for ACP without touching records", () => {
    const first = connection({ id: "api-1" });
    const list = { version: 1 as const, activeId: "api-1", initialized: true, connections: [first] };
    const acp = defaultProviderConfig("acp");
    const cleared = resolveProviderChange(list, acp);
    expect(cleared.missing).toBe(false);
    expect(cleared.persist).toMatchObject({ activeId: null });
    expect(cleared.persist?.connections).toEqual([first]);
    expect(cleared.provider).toEqual(acp);
    const alreadyClear = resolveProviderChange({ ...list, activeId: null }, acp);
    expect(alreadyClear.persist).toBeNull();
  });
  it("switches to the referenced record without rewriting the active one", () => {
    const first = connection({ id: "api-1", endpoint: "https://a.example.com/v1", model: "model-a" });
    const second = connection({ id: "api-2", endpoint: "https://b.example.com/v1", model: "model-b" });
    const list = { version: 1 as const, activeId: "api-1", initialized: true, connections: [first, second] };
    const next = buildProviderConfigFromConnection(second);
    const decided = resolveProviderChange(list, next);
    expect(decided.missing).toBe(false);
    expect(decided.persist).toMatchObject({ activeId: "api-2" });
    expect(decided.persist?.connections).toEqual([first, second]);
    expect(decided.provider).toEqual(next);
  });
  it("rejects missing or deleted connection IDs while keeping the previous selection", () => {
    const first = connection({ id: "api-1" });
    const list = { version: 1 as const, activeId: "api-1", initialized: true, connections: [first] };
    const ghost = { ...buildProviderConfigFromConnection(first), connectionId: "api-gone" };
    const decided = resolveProviderChange(list, ghost);
    expect(decided.missing).toBe(true);
    expect(decided.persist).toBeNull();
    expect(decided.provider).toBeNull();
  });
  it.each(["openai_chat_completions", "anthropic"] as const)("restores the saved %s record when a same-ID conversation uses the old protocol", (protocol) => {
    const target = connection({ protocol });
    const other = connection({ id: "api-other" });
    const stale = buildProviderConfigFromConnection(connection({ protocol: protocol === "anthropic" ? "openai_chat_completions" : "anthropic", endpoint: "https://old.example.com/v1", model: "old-model" }));
    for (const activeId of [target.id, other.id, null]) {
      const list = { version: 1 as const, activeId, initialized: true, connections: [target, other] };
      const decided = resolveProviderChange(list, stale);
      expect(decided.provider).toEqual(buildProviderConfigFromConnection(target));
      expect(decided.missing).toBe(false);
      if (activeId === target.id) expect(decided.persist).toBeNull();
      else expect(decided.persist).toEqual({ ...list, activeId: target.id });
      expect(list.connections).toEqual([target, other]);
    }
  });
  it.each(["openai_chat_completions", "anthropic"] as const)("clears named selection for ID-less %s choices without editing any record", (protocol) => {
    const first = connection();
    const second = connection({ id: "api-second", protocol: "anthropic" });
    const list = { version: 1 as const, activeId: first.id, initialized: true, connections: [first, second] };
    const legacy = buildProviderConfigFromConnection(connection({ protocol, endpoint: "https://legacy.example.com/v1", model: "legacy-model" }));
    const next = { ...legacy, connectionId: undefined };
    expect(resolveProviderChange(list, next)).toEqual({ persist: { ...list, activeId: null }, provider: next, missing: false });
    expect(resolveProviderChange({ ...list, activeId: null }, next)).toEqual({ persist: null, provider: next, missing: false });
    const defaults = defaultProviderConfig(protocol);
    expect(resolveProviderChange(list, defaults)).toEqual({ persist: { ...list, activeId: null }, provider: defaults, missing: false });
    expect(list.connections).toEqual([first, second]);
  });
  it.each(["openai_chat_completions", "anthropic"] as const)("preserves explicit same-ID %s field edits", (protocol) => {
    const target = connection({ protocol });
    const other = connection({ id: "api-other" });
    const list = { version: 1 as const, activeId: target.id, initialized: true, connections: [target, other] };
    const updated = { ...target, model: "chosen-model" };
    const next = buildProviderConfigFromConnection(updated);
    expect(resolveProviderChange(list, next)).toEqual({ persist: { ...list, connections: [updated, other] }, provider: next, missing: false });
    expect(resolveProviderChange(list, buildProviderConfigFromConnection(target))).toEqual({ persist: null, provider: buildProviderConfigFromConnection(target), missing: false });
  });
});

it("stores Responses as a separate named protocol while retaining Chat Completions connection IDs", () => {
  const responses = connection({ id: "responses", protocol: "openai_responses", endpoint: "https://example.test/v1/responses" });
  expect(sanitizeApiConnection(responses)).toEqual(responses);
  const provider = buildProviderConfigFromConnection(responses);
  expect(provider.kind).toBe("openai_responses");
  expect(provider.openai?.endpoint).toBe(responses.endpoint);
  expect(provider.connectionId).toBe("responses");
  const legacy = connection({ id: "existing-chat" });
  expect(buildProviderConfigFromConnection(legacy).kind).toBe("openai_chat_completions");
  expect(findConnectionForProvider({ ...defaultConnectionList(), connections: [legacy, responses] }, provider)?.id).toBe("responses");
});
