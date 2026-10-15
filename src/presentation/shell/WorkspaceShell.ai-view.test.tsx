import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiGateway, ApiConnectionStore, RuntimeGateway } from "../../application/ports";
import type { ApiConnectionList } from "../../domain/ai-connections";
import { sanitizeApiConnectionList } from "../../domain/ai-connections";
import { createAiViewPreferencesStore } from "../../infrastructure/storage/ai-view-preferences-store";
import { defaultAiViewPreferences } from "../../domain/ai-view-preferences";
import { WorkspaceShell } from "./WorkspaceShell";

const aiViewPreferencesStore = createAiViewPreferencesStore();

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("shell AI view composition", () => {
  it("shares visibility with chat, preserves a hidden current model and restores persisted width and controls", async () => {
    const testConnection = vi.fn().mockResolvedValue({ ok: true, detail: "advertised fixture", configOptions: [{ id: "real.option", name: "Models", category: "model", currentValue: "real/id", options: [{ value: "real/id", name: "Real model" }] }] });
    const gateway = { testConnection } as unknown as AiGateway;
    const runtimeGateway: RuntimeGateway = {
      /** Report only the mocked desktop state needed to mount this presentation test. */
      readStatus: async () => ({ contractVersion: 1, connection: "connected", detail: "fixture" }),
    };
    aiViewPreferencesStore.save({ ...defaultAiViewPreferences(), chatPaneWidth: 480 });
    const { unmount } = render(<WorkspaceShell desktop runtimeGateway={runtimeGateway} aiGateway={gateway} aiViewPreferencesStore={aiViewPreferencesStore} />);
    fireEvent.click(screen.getByRole("button", { name: "チャットを切り替える" }));
    const pane = screen.getByTestId("ai-sidebar");
    expect(pane).toHaveStyle({ width: "480px" });
    fireEvent.click(within(pane).getByRole("button", { name: "接続して候補を確認" }));
    await within(pane).findByRole("combobox", { name: "チャットのモデル" });
    const manage = within(pane).getByRole("button", { name: "AI の表示設定" }); manage.focus(); fireEvent.click(manage);
    const dialog = screen.getByRole("dialog", { name: "AI の表示設定" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Real model を表示" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "AI の表示設定を閉じる" }));
    expect(within(pane).getByRole("combobox", { name: "チャットのモデル" })).toHaveTextContent("Real model");
    expect(testConnection).toHaveBeenCalledOnce();
    fireEvent.keyDown(within(pane).getByRole("separator"), { key: "ArrowLeft" });
    expect(aiViewPreferencesStore.load().chatPaneWidth).toBe(496);
    fireEvent.click(manage);
    fireEvent.click(screen.getByRole("checkbox", { name: "チャットにモデルの選択欄を表示" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "チャットに接続先の選択欄を表示" }));
    fireEvent.click(screen.getByRole("button", { name: "AI の表示設定を閉じる" }));
    expect(within(pane).queryByRole("combobox", { name: "チャットのモデル" })).toBeNull();
    expect(within(pane).queryByRole("combobox", { name: "チャットの接続先" })).toBeNull();
    expect(aiViewPreferencesStore.load()).toMatchObject({ showModelSelector: false, showProviderSelector: false, hiddenModels: [{ provider: "codex", optionId: "real.option", value: "real/id" }] });
    unmount();
    render(<WorkspaceShell desktop runtimeGateway={runtimeGateway} aiGateway={gateway} aiViewPreferencesStore={aiViewPreferencesStore} />);
    fireEvent.click(screen.getByRole("button", { name: "チャットを切り替える" }));
    expect(screen.getByTestId("ai-sidebar")).toHaveStyle({ width: "496px" });
    expect(within(screen.getByTestId("ai-sidebar")).queryByRole("combobox", { name: "チャットの接続先" })).toBeNull();
    expect(within(screen.getByTestId("ai-sidebar")).getByRole("button", { name: "AI の表示設定" })).toBeEnabled();
    expect(testConnection).toHaveBeenCalledOnce();
  });
  it("keeps a hidden named connection selected while its dialog toggle restores independently", () => {
    const connections: ApiConnectionList = sanitizeApiConnectionList({ version: 1, initialized: true, activeId: "api-a", connections: [{ id: "api-a", name: "Twin", protocol: "openai_compatible", endpoint: "https://a.example/v1", model: "model-a" }, { id: "api-b", name: "Twin", protocol: "openai_compatible", endpoint: "https://b.example/v1", model: "model-a" }] });
    const store: ApiConnectionStore = {
      /** Load the twin-connection fixture for visibility plumbing. */
      load: () => connections,
      /** Accept visibility-driven persists without changing the fixture list. */
      save: () => true,
      /** Report a clean fixture store for shell composition. */
      inspect: () => ({ corrupted: false }),
    };
    const views = createAiViewPreferencesStore();
    views.save({ ...defaultAiViewPreferences(), hiddenConnectionIds: ["api-a"] });
    const gateway = { testConnection: vi.fn().mockResolvedValue({ ok: true, detail: "fixture" }) } as unknown as AiGateway;
    const runtime: RuntimeGateway = {
      /** Report only the mocked desktop state needed to mount this presentation test. */
      readStatus: async () => ({ contractVersion: 1, connection: "connected", detail: "fixture" }),
    };
    const { unmount } = render(<WorkspaceShell desktop runtimeGateway={runtime} aiGateway={gateway} aiViewPreferencesStore={views} apiConnectionStore={store} />);
    fireEvent.click(screen.getByRole("button", { name: "チャットを切り替える" }));
    const pane = screen.getByTestId("ai-sidebar");
    expect(within(pane).getByRole("combobox", { name: "チャットの接続先" })).toHaveTextContent("Twin");
    expect(within(pane).getByText("選択中の候補は非表示です")).toBeVisible();
    fireEvent.click(within(pane).getByRole("combobox", { name: "チャットの接続先" }));
    expect(screen.getAllByRole("option", { name: "Twin" })).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "接続先を検索" }), { key: "Escape" });
    const manage = within(pane).getByRole("button", { name: "AI の表示設定" }); fireEvent.click(manage);
    const dialog = screen.getByRole("dialog", { name: "AI の表示設定" });
    const toggles = within(dialog).getAllByRole("checkbox", { name: "Twin • OpenAI 互換 の候補を表示" });
    expect(toggles).toHaveLength(2);
    expect(toggles[0]).not.toBeChecked();
    expect(toggles[1]).toBeChecked();
    fireEvent.click(toggles[0]);
    expect(views.load().hiddenConnectionIds).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "AI の表示設定を閉じる" }));
    unmount();
    render(<WorkspaceShell desktop runtimeGateway={runtime} aiGateway={gateway} aiViewPreferencesStore={views} apiConnectionStore={store} />);
    fireEvent.click(screen.getByRole("button", { name: "チャットを切り替える" }));
    const restored = screen.getByTestId("ai-sidebar");
    fireEvent.click(within(restored).getByRole("combobox", { name: "チャットの接続先" }));
    expect(screen.getAllByRole("option", { name: "Twin" })).toHaveLength(2);
  });
});
