import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiConnectionSettings, describeApiConnection, type ApiConnectionControls } from "./ApiConnections";
import AiProviderSettings from "../ai-provider-settings";
import { defaultProviderConfig } from "../../domain/ai-config";
import { buildProviderConfigFromConnection, defaultConnectionList } from "../../domain/ai-connections";
import type { ApiConnection, ApiConnectionId } from "../../contracts/ai-contracts";
import { I18nProvider } from "../i18n/I18nProvider";
import { createTranslator } from "../../infrastructure/localization/i18next-translator";

/** Build one saved connection fixture with overridable fields. */
function saved(overrides: Partial<ApiConnection> = {}): ApiConnection {
  return { id: "api-1", name: "本番", protocol: "openai_compatible", endpoint: "https://api.example.com/v1", model: "model-a", ...overrides };
}

/** Build controllable connection callbacks recording every named operation. */
function controls(list = defaultConnectionList()): ApiConnectionControls & { calls: { select: ApiConnectionId[]; added: ApiConnection[]; updated: ApiConnection[]; deleted: ApiConnectionId[] } } {
  const calls = { select: [] as ApiConnectionId[], added: [] as ApiConnection[], updated: [] as ApiConnection[], deleted: [] as ApiConnectionId[] };
  return {
    list,
    activeId: list.activeId,
    /** Record connection selection without switching providers. */
    onSelect: (id) => { calls.select.push(id); return true; },
    /** Record connection registration without persisting secrets. */
    onAdd: (connection) => { calls.added.push(connection); return true; },
    /** Record connection edits without touching stable IDs. */
    onUpdate: (connection) => { calls.updated.push(connection); return true; },
    /** Record connection deletion without touching the credential store. */
    onDelete: (id) => { calls.deleted.push(id); return true; },
    /** Mint a fixed fixture ID outside render. */
    onMintId: () => "api-fresh" as ApiConnectionId,
    calls,
  };
}

/** Render settings fragments under both supported locales. */
function renderWithLocale(language: "ja-JP" | "en-US", element: React.ReactNode) {
  return render(<I18nProvider language={language} createTranslator={createTranslator}>{element}</I18nProvider>);
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
});

describe("named API connection settings", () => {
  it("shows the empty state and the add entry point", () => {
    const owned = controls();
    render(<ApiConnectionSettings {...owned} />);
    expect(screen.getByText("登録した API 接続先がありません。「API を追加」で登録します。")).toBeVisible();
    expect(screen.getByRole("button", { name: "API を追加" })).toBeVisible();
  });

  it("lists named connections with the active badge and selects wholesale", () => {
    const first = saved();
    const second = saved({ id: "api-2", name: "検証", protocol: "anthropic" });
    const owned = controls({ version: 1, activeId: "api-1", initialized: true, connections: [first, second] });
    render(<ApiConnectionSettings {...owned} />);
    expect(screen.getByText("本番")).toBeVisible();
    expect(screen.getByText("検証")).toBeVisible();
    expect(screen.getByText("使用中")).toBeVisible();
    fireEvent.click(screen.getByText("検証"));
    expect(owned.calls.select).toEqual(["api-2"]);
    expect(describeApiConnection(first)).toBe("本番 • OpenAI 互換");
  });

  it("rejects empty names without persisting", () => {
    const owned = controls();
    render(<ApiConnectionSettings {...owned} />);
    fireEvent.click(screen.getByRole("button", { name: "API を追加" }));
    expect(screen.getByRole("dialog", { name: "API 接続先を追加" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByText("接続先名は 1〜64 文字で指定します")).toBeVisible();
    expect(owned.calls.added).toEqual([]);
  });

  it("registers a validated connection with its secret reference", () => {
    const owned = controls();
    render(<ApiConnectionSettings {...owned} />);
    fireEvent.click(screen.getByRole("button", { name: "API を追加" }));
    fireEvent.change(screen.getByLabelText("接続先名"), { target: { value: "  開発  " } });
    fireEvent.change(screen.getByLabelText("モデル"), { target: { value: "model-b" } });
    fireEvent.change(screen.getByLabelText("資格情報の入力"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(owned.calls.added).toHaveLength(1);
    expect(owned.calls.added[0]).toMatchObject({ id: "api-fresh", name: "開発", protocol: "openai_compatible", model: "model-b" });
  });

  it("switches the protocol dropdown and its endpoint default", () => {
    const owned = controls();
    render(<ApiConnectionSettings {...owned} />);
    fireEvent.click(screen.getByRole("button", { name: "API を追加" }));
    expect(screen.getByLabelText("API エンドポイント")).toHaveValue("https://api.openai.com/v1");
    fireEvent.click(screen.getByRole("combobox", { name: "通信形式" }));
    fireEvent.click(screen.getByRole("option", { name: "Anthropic Messages" }));
    expect(screen.getByLabelText("API エンドポイント")).toHaveValue("https://api.anthropic.com/v1");
  });

  it("edits a saved connection without touching its stable ID", () => {
    const owned = controls({ version: 1, activeId: "api-1", initialized: true, connections: [saved()] });
    render(<ApiConnectionSettings {...owned} />);
    fireEvent.click(screen.getByRole("button", { name: "API 接続先を編集" }));
    fireEvent.change(screen.getByLabelText("接続先名"), { target: { value: "本番改" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(owned.calls.updated).toEqual([{ ...saved(), name: "本番改" }]);
  });

  it("confirms deletion with its credential handling before removing", () => {
    const owned = controls({ version: 1, activeId: "api-1", initialized: true, connections: [saved()] });
    render(<ApiConnectionSettings {...owned} />);
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(screen.getByText("この接続先を削除します。OS ストアの資格情報も削除します。")).toBeVisible();
    expect(owned.calls.deleted).toEqual([]);
    const confirm = screen.getByText("この接続先を削除します。OS ストアの資格情報も削除します。").closest("div")!;
    fireEvent.click(confirm.querySelectorAll("button")[1]);
    expect(owned.calls.deleted).toEqual(["api-1"]);
  });

  it("closes the dialog on Escape without persisting", () => {
    const owned = controls();
    render(<ApiConnectionSettings {...owned} />);
    const opener = screen.getByRole("button", { name: "API を追加" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "API 接続先を追加" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(owned.calls.added).toEqual([]);
  });

  it("reads per-connection credential presence through the gateway", async () => {
    const owned: ApiConnectionControls = {
      ...controls({ version: 1, activeId: "api-1", initialized: true, connections: [saved()] }),
      connectionGateway: {
        /** Report a stored fixture secret without touching the OS store. */
        getConnectionCredentialState: vi.fn(async (connectionId: ApiConnectionId) => ({ connectionId, hasSecret: true })),
        /** Accept a fixture secret without persisting it. */
        setConnectionCredential: vi.fn(async () => {}),
        /** Accept fixture credential deletion without side effects. */
        deleteConnectionCredential: vi.fn(async () => {}),
        /** Report a migrated fixture credential without copying secrets. */
        migrateConnectionCredential: vi.fn(async (connectionId: ApiConnectionId) => ({ connectionId, hasSecret: true })),
      },
    };
    render(<ApiConnectionSettings {...owned} />);
    fireEvent.click(screen.getByRole("button", { name: "API 接続先を編集" }));
    fireEvent.click(screen.getByRole("button", { name: "状態を確認" }));
    await waitFor(() => expect(screen.getByText("保存済み。値は表示しません。")).toBeVisible());
    expect(owned.connectionGateway!.getConnectionCredentialState).toHaveBeenCalledWith("api-1");
  });

  it("offers an explicit migration retry beside the failure notice", () => {
    /** Record a manual migration retry without touching any credential store. */
    const onRetryMigration = vi.fn();
    const owned = {
      ...controls({ version: 1, activeId: null, initialized: true, connections: [saved()] }),
      notice: "資格情報の引き継ぎに失敗しました。再試行できます。" as const,
      onRetryMigration,
    };
    render(<ApiConnectionSettings {...owned} />);
    expect(screen.getByText("資格情報の引き継ぎに失敗しました。再試行できます。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    expect(onRetryMigration).toHaveBeenCalledOnce();
    expect(owned.calls.select).toEqual([]);
  });

  it.each([["ja-JP", "API を追加"], ["en-US", "Add API"]] as const)("exposes the add entry point in %s", (language, label) => {
    renderWithLocale(language, <ApiConnectionSettings {...controls()} />);
    expect(screen.getByRole("button", { name: label })).toBeVisible();
  });

  it("drops the previous connection result after switching connections", async () => {
    const first = saved();
    const second = saved({ id: "api-2", name: "検証", protocol: "anthropic", endpoint: "https://api.anthropic.com/v1", model: "model-b" });
    const gateway = {
      getCredentialState: vi.fn(),
      setCredential: vi.fn(),
      deleteCredential: vi.fn(),
      /** Return a canned connection result without contacting any provider. */
      testConnection: vi.fn(async () => ({ ok: true, detail: "first-ok" })),
    };
    const list = { version: 1 as const, activeId: "api-1", initialized: true, connections: [first, second] };
    const owned = controls(list);
    const { rerender } = render(
      <AiProviderSettings embedded provider={buildProviderConfigFromConnection(first)} onProvider={vi.fn()} gateway={gateway} connectionControls={owned} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "設定を確認" }));
    await waitFor(() => expect(screen.getByText(/first-ok/)).toBeVisible());
    rerender(
      <AiProviderSettings embedded provider={buildProviderConfigFromConnection(second)} onProvider={vi.fn()} gateway={gateway} connectionControls={{ ...owned, activeId: "api-2" }} />,
    );
    expect(screen.queryByText(/first-ok/)).not.toBeInTheDocument();
    expect(defaultProviderConfig("acp")).toBeTruthy();
  });

  it("keeps the add dialog open when persistence fails", () => {
    const owned = controls();
    owned.onAdd = () => false;
    render(<ApiConnectionSettings {...owned} />);
    fireEvent.click(screen.getByRole("button", { name: "API を追加" }));
    fireEvent.change(screen.getByLabelText("接続先名"), { target: { value: "開発" } });
    fireEvent.change(screen.getByLabelText("モデル"), { target: { value: "model-b" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByRole("dialog", { name: "API 接続先を追加" })).toBeVisible();
  });

  it("keeps the delete confirmation open when persistence fails", () => {
    const owned = controls({ version: 1, activeId: "api-1", initialized: true, connections: [saved()] });
    owned.onDelete = () => false;
    render(<ApiConnectionSettings {...owned} />);
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    const confirm = screen.getByText("この接続先を削除します。OS ストアの資格情報も削除します。").closest("div")!;
    fireEvent.click(confirm.querySelectorAll("button")[1]);
    expect(screen.getByText("この接続先を削除します。OS ストアの資格情報も削除します。")).toBeVisible();
  });

  it("mounts the add dialog inside the live dark theme scope", () => {
    const owned = controls();
    render(<div data-theme="dark"><ApiConnectionSettings {...owned} /></div>);
    fireEvent.click(screen.getByRole("button", { name: "API を追加" }));
    const dialog = screen.getByRole("dialog", { name: "API 接続先を追加" });
    expect(dialog.closest("[data-theme]")).toHaveAttribute("data-theme", "dark");
  });
});
