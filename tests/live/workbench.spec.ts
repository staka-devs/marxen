import { expect, test, type Page } from "@playwright/test";

/** Render the production workbench using the explicitly simulated native fixture. */
async function openWorkbench(page: Page) {
  await page.goto("/tests/live/harness/editor.html");
  await page.waitForFunction(() => Boolean(window.__editorFixture));
  await page.evaluate(() => window.__editorFixture.load({ workbench: true, text: "# 日本語のメモ\n\n選択・編集・保存は実 Neovim が所有します。\n\n| 項目 | 状態 |\n| --- | --- |\n| メニュー | 確認中 |" }));
  await page.getByRole("menuitem", { name: "ファイル", exact: true }).click();
  await page.getByRole("menuitem", { name: "フォルダーを開く", exact: true }).click();
  await expect(page.getByTestId("editor-primary")).toBeVisible();
}

test("compact menus and captured contextual folder creation at full and narrow widths", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWorkbench(page);
  await expect(page.getByRole("menubar").getByRole("menuitem")).toHaveCount(6);
  await page.getByRole("menuitem", { name: "ファイル", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "ワークスペースにフォルダーを追加" })).toBeDisabled();
  await page.screenshot({ path: ".local/issue57-full.png", fullPage: true });
  await page.keyboard.press("Escape");
  const notes = page.getByRole("button", { name: "notes", exact: true });
  await notes.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "名前を変更", exact: true })).toBeEnabled();
  await page.screenshot({ path: ".local/issue57-context.png", fullPage: true });
  await page.getByRole("menuitem", { name: "名前を変更", exact: true }).click();
  const renameDialog = page.getByRole("dialog", { name: "名前の変更", exact: true });
  await expect(renameDialog).toBeVisible();
  await expect(renameDialog.getByLabel("新しいパス")).toHaveValue("notes");
  const callsBeforeRename = await page.evaluate(() => window.__editorFixture.getCalls());
  await renameDialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(renameDialog).toBeHidden();
  await expect(page.getByRole("button", { name: "notes", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__editorFixture.getCalls())).toEqual(callsBeforeRename);
  await notes.click({ button: "right" });
  await page.getByRole("menuitem", { name: "新規フォルダー", exact: true }).click();
  await expect(page.getByLabel("新規フォルダーのパス")).toHaveValue("notes/");
  await page.getByLabel("新規フォルダーのパス").fill("notes/今日");
  await page.getByRole("button", { name: "作成する", exact: true }).click();
  await expect(page.getByRole("button", { name: "notes/今日", exact: true })).toBeVisible();
  expect((await page.evaluate(() => window.__editorFixture.getCalls())).filter((call) => call.startsWith("create_folder:"))).toEqual(["create_folder:notes/今日"]);
  await page.setViewportSize({ width: 390, height: 780 });
  const menuBar = await page.getByRole("menubar").boundingBox();
  const sidebar = await page.getByRole("complementary", { name: "サイドバー", exact: true }).boundingBox();
  expect(sidebar!.y).toBeGreaterThanOrEqual(menuBar!.y + menuBar!.height);
  await page.getByRole("menuitem", { name: "ファイル", exact: true }).click();
  const bounds = await page.getByRole("menu", { name: "ファイル", exact: true }).boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: ".local/issue57-narrow.png", fullPage: true });
  await page.getByRole("menuitem", { name: "パスを入力する", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "フォルダーを開く", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: ".local/issue57-dialog-narrow.png", fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "ファイル", exact: true })).toBeFocused();
});
