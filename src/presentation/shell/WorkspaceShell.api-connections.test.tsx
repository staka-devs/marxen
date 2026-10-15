import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiGateway, ApiConnectionGateway, ApiConnectionStore, AiProfileStore, RuntimeGateway } from "../../application/ports";
import type { ApiConnectionList } from "../../domain/ai-connections";
import { defaultConnectionList, sanitizeApiConnectionList } from "../../domain/ai-connections";
import type { AiProfile } from "../../domain/ai-profile";
import { defaultProfile } from "../../domain/ai-profile";
import type { ApiConnection, ApiConnectionId } from "../../contracts/ai-contracts";
import { createAiViewPreferencesStore } from "../../infrastructure/storage/ai-view-preferences-store";
import { WorkspaceShell } from "./WorkspaceShell";

/** Build one named connection fixture with overridable fields. */
function named(overrides: Partial<ApiConnection> = {}): ApiConnection {
  return { id: "api-a", name: "API-A", protocol: "openai_compatible", endpoint: "https://a.example.com/v1", model: "model-a", ...overrides };
}

/** In-memory named-connection store with controllable persistence failures. */
function memoryConnectionStore(initial: ApiConnectionList) {
  let current = sanitizeApiConnectionList(initial);
  const state = { fail: false, saves: 0 };
  const store: ApiConnectionStore = {
    /** Load the current sanitized list, mirroring the real adapter. */
    load: () => current,
    /** Persist the sanitized list unless failure mode is armed, counting every attempt. */
    save: (list) => {
      state.saves += 1;
      if (state.fail) return false;
      current = sanitizeApiConnectionList(list);
      return true;
    },
    /** Report corruption only for the integer-marker fixture. */
    inspect: () => ({ corrupted: false }),
  };
  /** Read the current in-memory connection list. */
  const readCurrent = () => current;
  return { store, state, current: readCurrent };
}

/** In-memory legacy profile store retaining ACP choices across remounts. */
function memoryProfileStore(initial: AiProfile) {
  let current = initial;
  const store: AiProfileStore = {
    /** Load the current in-memory profile. */
    load: () => current,
    /** Persist the sanitized profile in memory. */
    save: (profile) => {
      current = profile;
    },
  };
  /** Read the current in-memory profile. */
  const readCurrent = () => current;
  return { store, current: readCurrent };
}

/** Recording per-connection credential gateway with controllable failures. */
function memoryCredentialGateway() {
  const calls = { set: [] as ApiConnectionId[], deleted: [] as ApiConnectionId[] };
  const state = { failDelete: false, failSet: false };
  const gateway: ApiConnectionGateway = {
    /** Report no stored secret in fixtures. */
    getConnectionCredentialState: async (connectionId) => ({ connectionId, hasSecret: false }),
    /** Record secret writes, optionally failing. */
    setConnectionCredential: async (connectionId) => {
      calls.set.push(connectionId);
      if (state.failSet) throw new Error("fixture credential write failed");
    },
    /** Record secret deletions, optionally failing after metadata success. */
    deleteConnectionCredential: async (connectionId) => {
      calls.deleted.push(connectionId);
      if (state.failDelete) throw new Error("fixture credential delete failed");
    },
    /** Report no migrated secret in fixtures. */
    migrateConnectionCredential: async (connectionId) => ({ connectionId, hasSecret: false }),
  };
  return { gateway, calls, state };
}

const runtimeGateway: RuntimeGateway = {
  /** Report only the mocked desktop state needed to mount this presentation test. */
  readStatus: async () => ({ contractVersion: 1, connection: "connected", detail: "fixture" }),
};

/** Probe connections in the fixture without contacting any provider. */
async function fixtureTestConnection() {
  return { ok: true, detail: "fixture" };
}

const aiGateway = { testConnection: vi.fn(fixtureTestConnection) } as unknown as AiGateway;

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(cleanup);

/** Open the settings dialog in the shell. */
function openSettings() {
  fireEvent.click(screen.getByRole("button", { name: "設定表示切替" }));
  return screen.getByTestId("settings");
}

/** Open the chat pane in the shell. */
function openChat() {
  fireEvent.click(screen.getByRole("button", { name: "チャットを切り替える" }));
  return screen.getByTestId("ai-sidebar");
}

describe("shell named-connection selection identity", () => {
  it("clears the named marker for ACP and restores ACP on remount", () => {
    const first = named();
    const connections = memoryConnectionStore({ version: 1, activeId: "api-a", initialized: true, connections: [first] });
    const profiles = memoryProfileStore({ ...defaultProfile(), kind: "acp", preset: "codex" } as AiProfile);
    const credentials = memoryCredentialGateway();
    const views = createAiViewPreferencesStore();
    const firstRender = render(
      <WorkspaceShell desktop runtimeGateway={runtimeGateway} aiGateway={aiGateway} aiViewPreferencesStore={views} apiConnectionStore={connections.store} aiProfileStore={profiles.store} apiConnectionGateway={credentials.gateway} />,
    );
    const pane = openChat();
    expect(within(pane).getByRole("combobox", { name: "チャットの接続先" })).toHaveTextContent("API-A");
    fireEvent.click(within(pane).getByRole("combobox", { name: "チャットの接続先" }));
    fireEvent.click(screen.getByRole("option", { name: "Codex" }));
    expect(connections.current().activeId).toBeNull();
    firstRender.unmount();
    render(
      <WorkspaceShell desktop runtimeGateway={runtimeGateway} aiGateway={aiGateway} aiViewPreferencesStore={views} apiConnectionStore={connections.store} aiProfileStore={profiles.store} apiConnectionGateway={credentials.gateway} />,
    );
    const second = openChat();
    expect(within(second).getByRole("combobox", { name: "チャットの接続先" })).toHaveTextContent("Codex");
    expect(connections.current().activeId).toBeNull();
  });

  it("switches A/B same-protocol connections without rewriting the inactive record", () => {
    const first = named({ id: "api-a", name: "API-A", endpoint: "https://a.example.com/v1", model: "model-a" });
    const second = named({ id: "api-b", name: "API-B", endpoint: "https://b.example.com/v1", model: "model-b" });
    const connections = memoryConnectionStore({ version: 1, activeId: "api-a", initialized: true, connections: [first, second] });
    const profiles = memoryProfileStore({ ...defaultProfile(), kind: "acp" } as AiProfile);
    const credentials = memoryCredentialGateway();
    const views = createAiViewPreferencesStore();
    render(
      <WorkspaceShell desktop runtimeGateway={runtimeGateway} aiGateway={aiGateway} aiViewPreferencesStore={views} apiConnectionStore={connections.store} aiProfileStore={profiles.store} apiConnectionGateway={credentials.gateway} />,
    );
    const settings = openSettings();
    const list = within(settings).getByTestId("api-connection-settings");
    fireEvent.click(within(list).getByText("API-B"));
    expect(connections.current().activeId).toBe("api-b");
    expect(connections.current().connections.find((item) => item.id === "api-a")).toEqual(first);
    expect(connections.current().connections.find((item) => item.id === "api-b")).toEqual(second);
    const pane = openChat();
    expect(within(pane).getByRole("combobox", { name: "チャットの接続先" })).toHaveTextContent("API-B");
  });

  it("blocks selection side effects when metadata persistence fails", () => {
    const first = named({ id: "api-a", name: "API-A" });
    const second = named({ id: "api-b", name: "API-B" });
    const connections = memoryConnectionStore({ version: 1, activeId: "api-a", initialized: true, connections: [first, second] });
    connections.state.fail = true;
    const profiles = memoryProfileStore({ ...defaultProfile(), kind: "acp" } as AiProfile);
    const credentials = memoryCredentialGateway();
    const views = createAiViewPreferencesStore();
    render(
      <WorkspaceShell desktop runtimeGateway={runtimeGateway} aiGateway={aiGateway} aiViewPreferencesStore={views} apiConnectionStore={connections.store} aiProfileStore={profiles.store} apiConnectionGateway={credentials.gateway} />,
    );
    const settings = openSettings();
    const list = within(settings).getByTestId("api-connection-settings");
    fireEvent.click(within(list).getByText("API-B"));
    expect(connections.state.saves).toBeGreaterThan(0);
    const pane = openChat();
    expect(within(pane).getByRole("combobox", { name: "チャットの接続先" })).toHaveTextContent("API-A");
    expect(credentials.calls.deleted).toEqual([]);
  });

  it("reports an accurate API message when persistence fails", () => {
    const first = named({ id: "api-a", name: "API-A" });
    const second = named({ id: "api-b", name: "API-B" });
    const connections = memoryConnectionStore({ version: 1, activeId: "api-a", initialized: true, connections: [first, second] });
    connections.state.fail = true;
    const profiles = memoryProfileStore({ ...defaultProfile(), kind: "acp" } as AiProfile);
    const credentials = memoryCredentialGateway();
    const views = createAiViewPreferencesStore();
    render(
      <WorkspaceShell desktop runtimeGateway={runtimeGateway} aiGateway={aiGateway} aiViewPreferencesStore={views} apiConnectionStore={connections.store} aiProfileStore={profiles.store} apiConnectionGateway={credentials.gateway} />,
    );
    const settings = openSettings();
    const list = within(settings).getByTestId("api-connection-settings");
    fireEvent.click(within(list).getByText("API-B"));
    expect(screen.getByText("API接続先を保存できませんでした。変更は適用されませんでした。")).toBeVisible();
  });

  it("surfaces delete credential failures with a retry that clears on success", async () => {
    const first = named({ id: "api-a", name: "API-A" });
    const connections = memoryConnectionStore({ version: 1, activeId: "api-a", initialized: true, connections: [first] });
    const profiles = memoryProfileStore({ ...defaultProfile(), kind: "acp" } as AiProfile);
    const credentials = memoryCredentialGateway();
    credentials.state.failDelete = true;
    const views = createAiViewPreferencesStore();
    render(
      <WorkspaceShell desktop runtimeGateway={runtimeGateway} aiGateway={aiGateway} aiViewPreferencesStore={views} apiConnectionStore={connections.store} aiProfileStore={profiles.store} apiConnectionGateway={credentials.gateway} />,
    );
    const settings = openSettings();
    const list = within(settings).getByTestId("api-connection-settings");
    fireEvent.click(within(list).getByRole("button", { name: "削除" }));
    const confirm = within(list).getByText("この接続先を削除します。OS ストアの資格情報も削除します。").closest("div")!;
    fireEvent.click(within(confirm as HTMLElement).getByRole("button", { name: "削除" }));
    expect(connections.current().connections).toHaveLength(0);
    expect(await within(settings).findByText("接続先を削除しましたが、OSストアの資格情報の削除に失敗しました。再試行できます。")).toBeVisible();
    expect(await within(settings).findByRole("button", { name: "資格情報の削除を再試行" })).toBeVisible();
    credentials.state.failDelete = false;
    fireEvent.click(within(settings).getByRole("button", { name: "資格情報の削除を再試行" }));
    expect(await screen.findByText("資格情報を削除しました。")).toBeVisible();
  });

  it("keeps the default empty list helper available for coverage", () => {
    expect(defaultConnectionList()).toEqual({ version: 1, activeId: null, connections: [], initialized: false });
  });
});
