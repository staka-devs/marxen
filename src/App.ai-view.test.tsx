import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import { testConnection } from "./infrastructure/tauri/ai-client";
import * as viewStorage from "./infrastructure/storage/ai-view-preferences-store";
import { defaultAiViewPreferences } from "./domain/ai-view-preferences";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  /** Exercise the real desktop composition without opening a native application. */
  isTauri: () => true,
}));
vi.mock("./infrastructure/tauri/ai-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./infrastructure/tauri/ai-client")>();
  const testConnection = vi.fn();
  return { ...actual, testConnection, aiGateway: { ...actual.aiGateway, testConnection } };
});
// Unrelated native subscriptions and Vim operations are outside this composition test.
vi.mock("./infrastructure/native/drop", () => ({ dropGateway: undefined }));
vi.mock("./infrastructure/tauri/ai-usage", () => ({ aiUsageGateway: undefined, codexAccountUsageGateway: undefined, transcriptUsageGateway: undefined }));
vi.mock("./infrastructure/vim-settings/tauri-vim-settings", () => ({ vimSettingsGateway: undefined }));

beforeEach(() => {
  vi.restoreAllMocks(); vi.resetAllMocks(); localStorage.clear();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "get_runtime_status") return { contractVersion: 1, connection: "connected", detail: "fixture" } as never;
    throw new Error(`Unexpected native operation: ${command}`);
  });
  vi.mocked(testConnection).mockResolvedValue({ ok: true, detail: "advertised fixture", configOptions: [{ id: "actual.model", name: "Models", category: "model", currentValue: "published/id", options: [{ value: "published/id", name: "Published model" }] }] });
});

it("creates one composition store and shares persisted settings with the actual chat and pane", async () => {
  localStorage.setItem("marxen.ai-view-preferences.v1", JSON.stringify({ ...defaultAiViewPreferences(), chatPaneWidth: 480 }));
  const createStore = vi.spyOn(viewStorage, "createAiViewPreferencesStore");
  const first = render(<App />);
  expect(createStore).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "チャットを切り替える" }));
  const pane = screen.getByTestId("ai-sidebar");
  expect(pane).toHaveStyle({ width: "480px" });
  fireEvent.click(within(pane).getByRole("button", { name: "接続して候補を確認" }));
  await within(pane).findByRole("combobox", { name: "チャットのモデル" });
  fireEvent.click(screen.getByRole("button", { name: "設定表示切替" }));
  const settings = screen.getByRole("dialog", { name: "設定" });
  fireEvent.click(within(settings).getByRole("button", { name: "AI" }));
  const visibility = within(settings).getByRole("region", { name: "AI の表示設定" });
  expect(within(visibility).getByRole("heading", { name: "AI の表示設定" })).toBeVisible();
  expect(within(visibility).getByRole("checkbox", { name: "Published model を表示" })).toBeChecked();
  expect(within(visibility).getByText("希望するチャット幅: 480px")).toBeVisible();
  fireEvent.click(within(visibility).getByRole("checkbox", { name: "Published model を表示" }));
  fireEvent.click(within(visibility).getByRole("checkbox", { name: "チャットに接続先の選択欄を表示" }));
  fireEvent.click(within(settings).getByRole("button", { name: "設定を閉じる" }));
  expect(within(pane).queryByRole("combobox", { name: "チャットの接続先" })).toBeNull();
  expect(within(pane).getByRole("combobox", { name: "チャットのモデル" })).toHaveTextContent("Published model");
  fireEvent.keyDown(within(pane).getByRole("separator"), { key: "ArrowLeft" });
  fireEvent.click(screen.getByRole("button", { name: "設定表示切替" }));
  expect(within(screen.getByRole("dialog", { name: "設定" })).getByText("希望するチャット幅: 496px")).toBeVisible();
  expect(createStore).toHaveBeenCalledOnce();
  expect(testConnection).toHaveBeenCalledOnce();
  first.unmount();
  render(<App />);
  expect(createStore).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "チャットを切り替える" }));
  expect(screen.getByTestId("ai-sidebar")).toHaveStyle({ width: "496px" });
  expect(within(screen.getByTestId("ai-sidebar")).queryByRole("combobox", { name: "チャットの接続先" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "設定表示切替" }));
  expect(screen.getByRole("checkbox", { name: "チャットに接続先の選択欄を表示" })).not.toBeChecked();
  expect(viewStorage.loadAiViewPreferences()).toMatchObject({ hiddenModels: [{ provider: "codex", optionId: "actual.model", value: "published/id" }], showProviderSelector: false, chatPaneWidth: 496 });
  expect(testConnection).toHaveBeenCalledOnce();
});
