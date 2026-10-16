import { describe, expect, it, vi } from "vitest";
import { API_CONNECTIONS_STORAGE_KEY, defaultConnectionList } from "../../domain/ai-connections";
import { inspectApiConnectionStorage, loadApiConnections, saveApiConnections } from "./api-connections-store";

/** Seed one saved connection fixture for storage round-trips. */
function storedList() {
  return {
    version: 1 as const,
    activeId: "api-1",
    initialized: true,
    connections: [
      { id: "api-1", name: "本番", protocol: "openai_chat_completions" as const, endpoint: "https://api.example.com/v1", model: "model-a" },
      { id: "api-2", name: "検証", protocol: "anthropic" as const, endpoint: "https://api.anthropic.com/v1", model: "model-b" },
    ],
  };
}

/** Fail the next localStorage write exactly once via a prototype spy. */
function failNextWrite() {
  const spy = vi.spyOn(Object.getPrototypeOf(window.localStorage), "setItem").mockImplementationOnce(() => {
    throw new Error("quota exceeded in fixture");
  });
  return () => spy.mockRestore();
}

/** Fail every localStorage read with a blocked-storage error, then restore. */
function failReads() {
  const spy = vi.spyOn(Object.getPrototypeOf(window.localStorage), "getItem").mockImplementation(() => {
    throw new Error("storage blocked in fixture");
  });
  return () => spy.mockRestore();
}

describe("named API connections persist non-secrets only", () => {
  it("round-trips id/name/protocol/endpoint/model and the active selection", () => {
    expect(saveApiConnections(storedList())).toBe(true);
    expect(loadApiConnections()).toEqual(storedList());
  });

  it("blocks migration on corrupt, unsupported, or unusable stored data", () => {
    window.localStorage.setItem(API_CONNECTIONS_STORAGE_KEY, JSON.stringify({ version: 1, activeId: "api-gone", connections: [{ id: "bad id", name: "", protocol: "acp" }] }));
    expect(loadApiConnections()).toEqual({ ...defaultConnectionList(), initialized: true });
    expect(inspectApiConnectionStorage()).toEqual({ corrupted: true });
    window.localStorage.setItem(API_CONNECTIONS_STORAGE_KEY, "{broken");
    const corrupt = loadApiConnections();
    expect(corrupt).toEqual({ ...defaultConnectionList(), initialized: true });
    expect(inspectApiConnectionStorage()).toEqual({ corrupted: true });
    expect(window.localStorage.getItem(API_CONNECTIONS_STORAGE_KEY)).toBe("{broken");
    window.localStorage.setItem(API_CONNECTIONS_STORAGE_KEY, JSON.stringify({ version: 2, activeId: "api-9", connections: [{ id: "api-9", name: "未来", protocol: "openai_chat_completions", endpoint: "https://api.example.com/v1", model: "m" }] }));
    const future = loadApiConnections();
    expect(future.initialized).toBe(true);
    expect(future.connections).toHaveLength(1);
    expect(inspectApiConnectionStorage()).toEqual({ corrupted: true });
    expect(window.localStorage.getItem(API_CONNECTIONS_STORAGE_KEY)).toContain("api-9");
  });

  it("reports clean storage only for missing keys and valid lists", () => {
    window.localStorage.removeItem(API_CONNECTIONS_STORAGE_KEY);
    expect(inspectApiConnectionStorage()).toEqual({ corrupted: false });
    expect(saveApiConnections(storedList())).toBe(true);
    expect(inspectApiConnectionStorage()).toEqual({ corrupted: false });
    window.localStorage.setItem(API_CONNECTIONS_STORAGE_KEY, JSON.stringify({ version: 1, activeId: "api-1", connections: [storedList().connections[0], storedList().connections[0]] }));
    expect(inspectApiConnectionStorage()).toEqual({ corrupted: true });
  });

  it("reports write failures without touching the previously stored bytes", () => {
    expect(saveApiConnections(storedList())).toBe(true);
    const before = window.localStorage.getItem(API_CONNECTIONS_STORAGE_KEY);
    const restore = failNextWrite();
    try {
      expect(saveApiConnections({ ...storedList(), activeId: "api-2" })).toBe(false);
    } finally {
      restore();
    }
    expect(window.localStorage.getItem(API_CONNECTIONS_STORAGE_KEY)).toBe(before);
    expect(loadApiConnections()).toEqual(storedList());
  });

  it("stays migration-blocked when storage reads are unavailable", () => {
    const restore = failReads();
    try {
      expect(loadApiConnections()).toEqual({ ...defaultConnectionList(), initialized: true });
    } finally {
      restore();
    }
  });

  it("never stores secret material", () => {
    saveApiConnections({
      version: 1,
      activeId: "api-1",
      initialized: true,
      connections: [{ id: "api-1", name: "本番", protocol: "openai_chat_completions", endpoint: "https://api.example.com/v1", model: "m" }],
    });
    const stored = window.localStorage.getItem(API_CONNECTIONS_STORAGE_KEY) ?? "";
    expect(stored).not.toContain("s3cret");
    expect(JSON.parse(stored)).not.toHaveProperty("secret");
    expect(JSON.parse(stored).connections[0]).not.toHaveProperty("secret");
  });
});

it("keeps the old API namespace untouched and requires explicit registration in the new namespace", () => {
  localStorage.removeItem(API_CONNECTIONS_STORAGE_KEY);
  const previous = '{"protocol":"openai_compatible"}';
  localStorage.setItem("marxen.api-connections.v1", previous);
  expect(loadApiConnections().connections).toEqual([]);
  expect(localStorage.getItem("marxen.api-connections.v1")).toBe(previous);
  expect(API_CONNECTIONS_STORAGE_KEY).toBe("marxen.api-connections.v2");
});
