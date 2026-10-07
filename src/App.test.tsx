import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import { readRuntimeStatus } from "./lib/runtime";
import { READONLY_MESSAGE } from "./lib/document-client";

vi.mock("./lib/runtime", () => ({ readRuntimeStatus: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => false }));
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
  expect(screen.getByTestId("gui-toolbar")).toBeVisible();
  expect(screen.getByTestId("editor-primary")).toBeVisible();
  expect(screen.getByTestId("preview")).toBeVisible();
  expect(screen.getByTestId("revision")).toHaveTextContent("リビジョン 0");
  expect(screen.getByTestId("readonly-note")).toBeVisible();
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
  expect(screen.getByRole("button", { name: "チェックリストを切り替える" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "コマンド" }));
  fireEvent.click(await screen.findByText("ファイル: 保存する"));
  expect(await screen.findByRole("alert")).toHaveTextContent(READONLY_MESSAGE);
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
  const before = screen.getByTestId("preview").textContent;
  fireEvent.click(screen.getByRole("button", { name: "閲覧" }));
  expect(screen.getByTestId("preview")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "原文" }));
  expect(screen.getByTestId("editor-primary")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "分割" }));
  expect(screen.getByTestId("editor-secondary")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "ライブ" }));
  expect(screen.getByTestId("preview").textContent).toBe(before);
});
