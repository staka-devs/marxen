import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiGateway, ApiConnectionGateway, ApiConnectionStore, AiProfileStore, DocumentGateway, IsolationGateway, RuntimeGateway, WorkspaceGateway } from "../../application/ports";
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

/** Supply a native document and local-only transport so real chat history can be exercised. */
function historyPorts() {
  const snapshot = { documentId: "doc-fixture", revision: 0, text: "API selection fixture", dirty: false };
  return {
    documentGateway: {
      /** Accept the fixed native snapshot without editing it. */
      noteSnapshot: () => {},
      /** Return the document captured by the chat staging scope. */
      fetchSnapshot: async () => snapshot,
      /** Report the fixture's native configuration. */
      fetchConfig: async () => ({ path: null, errors: [] }),
      /** Report the fixture's native mode. */
      fetchMode: async () => ({ mode: "normal", revision: 0 }),
      /** Report the fixture's native cursor. */
      fetchCursor: async () => ({ documentId: snapshot.documentId, revision: 0, anchor: 0, head: 0 }),
    } as unknown as DocumentGateway,
    workspaceGateway: {
      /** Open the fixture workspace. */
      openWorkspace: async () => ({ root: "/fixture", scope: { rootId: "fixture-root", generation: "1" } }),
      /** Keep the explorer empty; the document is already open natively. */
      listWorkspace: async () => [],
      /** Restore the open native document through the real shell. */
      listDocuments: async () => [{ path: "fixture.md", snapshot }],
      /** Report no recovery entries. */
      listRecovery: async () => [],
      /** Report no pending native events. */
      pollEvents: async () => [],
    } as unknown as WorkspaceGateway,
    eventSource: {
      /** Subscribe without generating unrelated native events. */
      listen: async () => () => {},
    },
    isolationGateway: {
      /** Register the exact document scope without touching disk. */
      createCopy: async () => ({ copyId: "copy-fixture", documents: [] }),
    } as unknown as IsolationGateway,
    aiGateway: {
      ...aiGateway,
      /** Retain a cancelled turn in real history without contacting an API. */
      startPrompt: async (_request, onEvent) => {
        onEvent({ type: "cancelled", payload: { runId: "run-fixture" } });
        return {
          runId: "run-fixture",
          /** Release the already-settled local run. */
          stop: async () => {},
        };
      },
    } satisfies AiGateway,
  };
}

/** Open the fixture workspace through the shell's normal menu path. */
async function openHistoryDocument() {
  fireEvent.click(screen.getByRole("menuitem", { name: "ファイル" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "パスを入力する" }));
  fireEvent.change(screen.getByLabelText("開くフォルダーの絶対パス"), { target: { value: "/fixture" } });
  fireEvent.click(screen.getByRole("button", { name: "開く" }));
  await screen.findByTestId("editor-primary");
}

/** Retain a real chat turn for later selection from the history view. */
async function retainConversation(pane: HTMLElement, prompt: string) {
  fireEvent.change(within(pane).getByLabelText("プロンプト"), { target: { value: prompt } });
  fireEvent.click(within(pane).getByRole("button", { name: "送信" }));
  await within(pane).findByText(prompt);
  await waitFor(() => expect(within(pane).getByRole("button", { name: "新しい会話" })).toBeEnabled());
}

/** Restore one historical provider through the real chat history controls. */
function selectHistory(pane: HTMLElement, prompt: string) {
  fireEvent.click(within(pane).getByRole("button", { name: "履歴を開く" }));
  fireEvent.click(within(pane).getByRole("button", { name: new RegExp(prompt) }));
}

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
  it("restores the saved protocol after selecting an old same-ID conversation", async () => {
    const first = named();
    const other = named({ id: "api-b", name: "API-B" });
    const connections = memoryConnectionStore({ version: 1, activeId: first.id, initialized: true, connections: [first, other] });
    const profiles = memoryProfileStore(defaultProfile());
    render(<WorkspaceShell desktop runtimeGateway={runtimeGateway} {...historyPorts()} apiConnectionStore={connections.store} aiProfileStore={profiles.store} />);
    await openHistoryDocument();
    const pane = openChat();
    await retainConversation(pane, "old protocol conversation");
    const settings = openSettings();
    const list = within(settings).getByTestId("api-connection-settings");
    fireEvent.click(within(list).getAllByRole("button", { name: "API 接続先を編集" })[0]);
    let dialog = screen.getByRole("dialog", { name: "API 接続先を編集" });
    fireEvent.click(within(dialog).getByRole("combobox", { name: "通信形式" }));
    fireEvent.click(screen.getByRole("option", { name: "Anthropic Messages" }));
    dialog = screen.getByRole("dialog", { name: "API 接続先を編集" });
    fireEvent.change(within(dialog).getByLabelText("API エンドポイント"), { target: { value: "https://current.example.com/v1" } });
    fireEvent.change(within(dialog).getByLabelText("モデル"), { target: { value: "current-model" } });
    expect(within(dialog).getByRole("combobox", { name: "通信形式" })).toHaveTextContent("Anthropic Messages");
    expect(within(dialog).getByLabelText("API エンドポイント")).toHaveValue("https://current.example.com/v1");
    expect(within(dialog).getByLabelText("モデル")).toHaveValue("current-model");
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(screen.queryByRole("dialog", { name: "API 接続先を編集" })).toBeNull();
    fireEvent.click(within(settings).getByRole("button", { name: "設定を閉じる" }));
    const saved = connections.current();
    expect(saved.connections[0]).toEqual({ ...first, protocol: "anthropic", endpoint: "https://current.example.com/v1", model: "current-model" });
    const saves = connections.state.saves;
    selectHistory(pane, "old protocol conversation");
    expect(connections.current()).toEqual(saved);
    expect(connections.state.saves).toBe(saves);
    expect(within(pane).getByRole("combobox", { name: "チャットの接続先" })).toHaveTextContent("API-A");
    expect(within(pane).getByLabelText("チャットのモデル")).toHaveValue("current-model");
    fireEvent.change(within(pane).getByLabelText("チャットのモデル"), { target: { value: "explicit-model" } });
    expect(connections.current().connections).toEqual([{ ...saved.connections[0], model: "explicit-model" }, other]);
  });

  it.each(["openai_compatible", "anthropic"] as const)("restores ID-less %s history only after saving and retains it across remount", async (kind) => {
    const first = named();
    const other = named({ id: "api-b", name: "API-B", protocol: "anthropic" });
    const records = [first, other];
    const connections = memoryConnectionStore({ version: 1, activeId: null, initialized: true, connections: records });
    const legacy = { ...defaultProfile(), kind, endpoint: "https://legacy.example.com/v1", model: "legacy-model", anthropicEnabled: true };
    const profiles = memoryProfileStore(legacy);
    const props = { desktop: true, runtimeGateway, ...historyPorts(), apiConnectionStore: connections.store, aiProfileStore: profiles.store };
    const mounted = render(<WorkspaceShell {...props} />);
    await openHistoryDocument();
    const pane = openChat();
    await retainConversation(pane, "legacy conversation");
    fireEvent.click(within(pane).getByRole("combobox", { name: "チャットの接続先" }));
    fireEvent.click(screen.getByRole("option", { name: "API-A" }));
    const saves = connections.state.saves;
    connections.state.fail = true;
    selectHistory(pane, "legacy conversation");
    expect(connections.state.saves).toBe(saves + 1);
    expect(connections.current()).toEqual({ version: 1, activeId: first.id, initialized: true, connections: records });
    expect(within(pane).getByRole("combobox", { name: "チャットの接続先" })).toHaveTextContent("API-A");
    expect(within(pane).getByLabelText("チャットのモデル")).toHaveValue(first.model);
    expect(within(pane).queryByText("legacy conversation")).toBeNull();
    expect(screen.getByText("API接続先を保存できませんでした。変更は適用されませんでした。")).toBeVisible();
    connections.state.fail = false;
    selectHistory(pane, "legacy conversation");
    expect(connections.current()).toEqual({ version: 1, activeId: null, initialized: true, connections: records });
    expect(within(pane).getByLabelText("チャットのモデル")).toHaveValue(legacy.model);
    expect(profiles.current()).toMatchObject(legacy);
    mounted.unmount();
    render(<WorkspaceShell {...props} />);
    const restored = openChat();
    expect(within(restored).getByLabelText("チャットのモデル")).toHaveValue(legacy.model);
    expect(profiles.current()).toMatchObject(legacy);
    expect(connections.current()).toEqual({ version: 1, activeId: null, initialized: true, connections: records });
  });

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
    const confirm = within(list).getByText("接続先と API キーを削除します。").closest("div")!;
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
