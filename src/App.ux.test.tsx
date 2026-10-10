import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import App from "./App";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  /** Keep the UX fixture in read-only browser mode. */
  isTauri: () => false,
}));
beforeEach(() => window.localStorage.clear());

it("finds settings across categories and preserves an immediately applied font size", async () => {
  render(<App />);
  await screen.findByTestId("editor-primary");
  const trigger = screen.getByRole("button", { name: "設定表示切替" });
  trigger.focus(); fireEvent.click(trigger);
  expect(screen.getByLabelText("設定を検索")).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "AI" }));
  fireEvent.change(screen.getByLabelText("設定を検索"), { target: { value: "文字サイズ" } });
  expect(screen.getByLabelText("文字サイズ")).toBeVisible();
  expect(screen.queryByLabelText("Neovim 設定ファイルのパス")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("文字サイズ"), { target: { value: "19" } });
  fireEvent.change(screen.getByLabelText("設定を検索"), { target: { value: "存在しない設定" } });
  expect(screen.getByText("一致する設定がありません。")).toBeVisible();
  fireEvent.keyDown(screen.getByTestId("settings"), { key: "Escape" });
  expect(trigger).toHaveFocus(); fireEvent.click(trigger);
  expect(screen.getByLabelText("文字サイズ")).toHaveValue(19);
});

it("dismisses operations with Escape and outside pointer events and restores trigger focus", async () => {
  render(<App />); await screen.findByTestId("editor-primary");
  const trigger = screen.getByRole("button", { name: "その他の操作" });
  trigger.focus(); fireEvent.click(trigger);
  const panel = screen.getByRole("dialog", { name: "エディター操作" });
  fireEvent.keyDown(panel, { key: "ArrowDown" });
  expect(screen.getByRole("button", { name: "Vim" })).toHaveFocus();
  fireEvent.keyDown(panel, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "エディター操作" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus(); fireEvent.click(trigger);
  fireEvent.pointerDown(screen.getByTestId("editor-primary"));
  expect(screen.queryByRole("dialog", { name: "エディター操作" })).not.toBeInTheDocument();
});

it("resizes the explorer by keyboard and shows source line numbers only in Markdown mode", async () => {
  render(<App />); const editor = await screen.findByTestId("editor-primary");
  const handle = screen.getByRole("separator", { name: "サイドバーの幅" });
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(handle).toHaveAttribute("aria-valuenow", "250");
  expect(editor.querySelector(".cm-lineNumbers")).toBeNull();
  fireEvent.change(screen.getByLabelText("表示モード"), { target: { value: "source" } });
  expect(screen.getByTestId("editor-primary").querySelector(".cm-lineNumbers")).not.toBeNull();
  expect(screen.getByTestId("editor-primary").textContent).toContain("# はじめに");
});

