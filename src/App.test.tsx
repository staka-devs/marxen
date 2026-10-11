import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import { readRuntimeStatus } from "./infrastructure/tauri/runtime-client";
import { READONLY_MESSAGE } from "./domain/document-errors";

vi.mock("./infrastructure/tauri/runtime-client", () => {
  /** Mocked status reader controllable per test. */
  const readRuntimeStatus = vi.fn();
  return {
    readRuntimeStatus,
    /** Gateway delegating to the mocked status reader. */
    runtimeGateway: {
      /** Status reader delegating to the mock. */
      readStatus: readRuntimeStatus,
    },
  };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  /** Browser demo flag for read-only shell tests. */
  isTauri: () => false,
}));
beforeEach(() => vi.resetAllMocks());

it("shows the Japanese workspace shell with disconnected status", async () => {
  vi.mocked(readRuntimeStatus).mockResolvedValue({
    contractVersion: 1,
    connection: "disconnected",
    detail: "ブラウザ表示です。デスクトップの Neovim には接続していません。",
  });
  render(<App />);
  expect(await screen.findByText("Neovim 未接続")).toBeVisible();
  expect(screen.getByTestId("workspace-shell")).toBeVisible();
  expect(screen.getByTestId("file-tree")).toBeVisible();
  expect(screen.getByTestId("tabs")).toBeVisible();
  expect(screen.getByTestId("editor-primary")).toBeVisible();
  expect(screen.getByTestId("revision")).toHaveTextContent("リビジョン 0");
  expect(screen.getByTestId("readonly-note")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "その他の操作" }));
  expect(screen.getByTestId("gui-toolbar")).toBeVisible();
});

it("stays read-only in the browser and never simulates save success", async () => {
  vi.mocked(readRuntimeStatus).mockResolvedValue({
    contractVersion: 1,
    connection: "disconnected",
    detail: "browser",
  });
  render(<App />);
  expect(await screen.findByTestId("editor-primary")).toBeVisible();
  // Toolbar and save stay disabled; attempting a GUI action only explains readonly.
  fireEvent.click(screen.getByRole("button", { name: "その他の操作" }));
  expect(screen.getByRole("button", { name: "チェックリストを切り替える" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  fireEvent.click(screen.getByRole("menuitem", { name: "コマンドパレット" }));
  fireEvent.click(await screen.findByText("ファイル: 保存する"));
  const notice = await screen.findByTestId("notification-toast");
  expect(notice).toHaveAttribute("role", "status");
  expect(notice).toHaveTextContent(READONLY_MESSAGE);
  expect(screen.getByTestId("revision")).toHaveTextContent("リビジョン 0");
  expect(screen.getByTestId("dirty")).toHaveTextContent("保存済み");
});

it("switches live/source/read/split without losing the document", async () => {
  vi.mocked(readRuntimeStatus).mockResolvedValue({
    contractVersion: 1,
    connection: "disconnected",
    detail: "browser",
  });
  render(<App />);
  await screen.findByTestId("editor-primary");
  // Live uses true inline widgets inside .cm-content (no separate preview);
  // read/split use the shared read preview. Mode switches keep the document.
  expect(screen.getByTestId("editor-primary")).toBeVisible();
  expect(screen.queryByTestId("preview")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("表示モード"), { target: { value: "read" } });
  await within(screen.getByTestId("preview")).findByText("日本語で書く");
  expect(screen.getByTestId("preview")).toBeVisible();
  const before = screen.getByTestId("preview").textContent;
  fireEvent.change(screen.getByLabelText("表示モード"), { target: { value: "source" } });
  expect(screen.getByTestId("editor-primary")).toBeVisible();
  fireEvent.change(screen.getByLabelText("表示モード"), { target: { value: "split" } });
  expect(screen.getByTestId("editor-primary")).toBeVisible();
  await within(screen.getByTestId("preview")).findByText("日本語で書く");
  expect(screen.queryByTestId("editor-secondary")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("表示モード"), { target: { value: "read" } });
  await within(screen.getByTestId("preview")).findByText("日本語で書く");
  expect(screen.getByTestId("preview").textContent).toBe(before);
  fireEvent.change(screen.getByLabelText("表示モード"), { target: { value: "live" } });
  expect(screen.getByTestId("editor-primary")).toBeVisible();
});
