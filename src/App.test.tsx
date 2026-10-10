import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import { readRuntimeStatus } from "./lib/runtime";

vi.mock("./lib/runtime", () => ({ readRuntimeStatus: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

it("shows disconnected state and does not offer fake editor actions", async () => {
  vi.mocked(readRuntimeStatus).mockResolvedValue({ contractVersion: 1, connection: "disconnected", detail: "Neovim actor は未実装です。" });
  render(<App />);
  expect(await screen.findByText("Neovim 未接続")).toBeVisible();
  expect(screen.getByText(/編集・保存・Vim モードはまだ利用できません/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
});

it("shows an IPC failure rather than a connected status", async () => {
  vi.mocked(readRuntimeStatus).mockRejectedValue(new Error("状態取得エラー"));
  render(<App />);
  expect(await screen.findByText("接続状態を取得できません")).toBeVisible();
  expect(screen.getByText("状態取得エラー")).toBeVisible();
});
