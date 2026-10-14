import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { WorkbenchMenuBar } from "./WorkbenchMenuBar";
import { I18nProvider } from "../i18n/I18nProvider";
import type { WorkbenchCommand } from "../../contracts/workbench";
import { createTranslator } from "../../infrastructure/localization/i18next-translator";

const commands: WorkbenchCommand[] = [
  { id: "folder-open", menu: "file", label: "フォルダーを開く", enabled: true },
  { id: "folder-add", menu: "file", label: "ワークスペースにフォルダーを追加", enabled: false, reason: "単一フォルダーのみ" },
  { id: "edit-copy", menu: "edit", label: "選択範囲をコピー", enabled: true },
];

it("renders six compact menus, traverses between them once, and restores trigger focus", () => {
  const run = vi.fn(); const prepare = vi.fn();
  render(<WorkbenchMenuBar commands={commands} onRun={run} onPrepare={prepare} />);
  const bar = screen.getByRole("menubar");
  expect(within(bar).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["ファイル", "編集", "選択", "表示", "移動", "ヘルプ"]);
  const file = within(bar).getByRole("menuitem", { name: "ファイル" }); file.focus();
  fireEvent.keyDown(file, { key: "ArrowDown" });
  const open = screen.getByRole("menuitem", { name: "フォルダーを開く" }); expect(open).toHaveFocus();
  expect(screen.getByRole("menuitem", { name: "ワークスペースにフォルダーを追加" })).toBeDisabled();
  fireEvent.click(screen.getByRole("menuitem", { name: "ワークスペースにフォルダーを追加" })); expect(run).not.toHaveBeenCalled();
  fireEvent.keyDown(open, { key: "ArrowRight" }); expect(screen.getByRole("menu", { name: "編集" })).toBeVisible();
  const copy = screen.getByRole("menuitem", { name: "選択範囲をコピー" }); expect(copy).toHaveFocus();
  fireEvent.keyDown(copy, { key: "Escape" }); expect(within(bar).getByRole("menuitem", { name: "編集" })).toHaveFocus();
  expect(screen.queryByRole("menu")).toBeNull();
});

it("updates menu labels when presentation language changes", () => {
  const view = render(<I18nProvider language="ja-JP" createTranslator={createTranslator}><WorkbenchMenuBar commands={commands} onRun={vi.fn()} onPrepare={vi.fn()} /></I18nProvider>);
  expect(screen.getByRole("menuitem", { name: "ファイル" })).toBeVisible();
  view.rerender(<I18nProvider language="en-US" createTranslator={createTranslator}><WorkbenchMenuBar commands={commands} onRun={vi.fn()} onPrepare={vi.fn()} /></I18nProvider>);
  expect(screen.getByRole("menuitem", { name: "File" })).toBeVisible();
  expect(screen.getByRole("menuitem", { name: "Help" })).toBeVisible();
});
