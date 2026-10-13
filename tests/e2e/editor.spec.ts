import { expect, test } from "@playwright/test";

// Issue #5 acceptance in the browser: the demo is read-only (real Neovim
// paths are covered by Rust integration tests src-tauri/tests/neovim.rs).
// E2E asserts mode retention, invalid-fixture safety, navigation UI, and
// that no save success or revision bump is ever simulated.

test("live/source/read/split retain the document without editing it", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("revision")).toHaveText("リビジョン 0");
  // The Issue #6 preview renders asynchronously; wait for content first.
  await expect(page.getByTestId("preview")).toContainText("日本語で書く");
  const before = await page.getByTestId("preview").textContent();

  await page.getByRole("button", { name: "閲覧", exact: true }).click();
  await expect(page.getByTestId("preview")).toBeVisible();

  await page.getByRole("button", { name: "原文", exact: true }).click();
  await expect(page.locator('[data-testid="editor-primary"] .cm-content')).toBeVisible();

  await page.getByRole("button", { name: "分割", exact: true }).click();
  await expect(page.locator('[data-testid="editor-secondary"] .cm-content')).toBeVisible();

  await page.getByRole("button", { name: "ライブ", exact: true }).click();
  await expect(page.getByTestId("preview")).toContainText("日本語で書く");
  expect(await page.getByTestId("preview").textContent()).toBe(before);
  await expect(page.getByTestId("revision")).toHaveText("リビジョン 0");

  await page.screenshot({ path: "docs/reports/issue-5-ui/live.png" });
  await page.getByRole("button", { name: "閲覧", exact: true }).click();
  await page.screenshot({ path: "docs/reports/issue-5-ui/read.png" });
  await page.getByRole("button", { name: "原文", exact: true }).click();
  await page.screenshot({ path: "docs/reports/issue-5-ui/source.png" });
  await page.getByRole("button", { name: "分割", exact: true }).click();
  await page.screenshot({ path: "docs/reports/issue-5-ui/split.png" });
});

test("invalid fixtures render safely without executing", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    (window as unknown as { __marxenUnsafe?: boolean }).__marxenUnsafe = false;
  });

  await page.getByRole("button", { name: "検証/安全でないHTML.md" }).click();
  const preview = page.getByTestId("preview");
  await expect(preview).toContainText("この本文は表示できる。");
  expect(await preview.locator("script").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __marxenUnsafe?: boolean }).__marxenUnsafe)).toBe(false);

  await page.getByRole("button", { name: "検証/不正な構文.md" }).click();
  await expect(page.getByTestId("preview")).toContainText("原文のまま残ること");
  await expect(page.getByTestId("revision")).toHaveText("リビジョン 0");
});

test("tree/tabs/quick-open/search/outline/palette/themes work in Japanese", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("file-tree")).toContainText("メモ/はじめに.md");
  await page.getByRole("button", { name: "メモ/東京.md" }).click();
  await expect(page.getByTestId("tabs")).toContainText("東京.md");

  await page.getByRole("button", { name: "クイックオープン" }).click();
  await expect(page.getByTestId("quick-open")).toBeVisible();
  await page.getByTestId("quick-open").getByLabel("ファイル名で絞り込む").fill("はじめ");
  await expect(page.getByTestId("quick-open")).toContainText("メモ/はじめに.md");
  await page.getByTestId("quick-open").getByRole("button", { name: "閉じる (Esc)" }).click();

  await expect(page.getByTestId("search-panel")).toBeVisible();
  await page.getByTestId("search-panel").getByLabel("検索語句").fill("東京");
  await expect(page.getByTestId("search-panel")).toContainText("件");

  await expect(page.getByTestId("outline")).toBeVisible();

  await page.getByRole("button", { name: "コマンド" }).click();
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.screenshot({ path: "docs/reports/issue-5-ui/palette.png" });
  await page.getByTestId("command-palette").getByLabel("コマンドで絞り込む").fill("保存");
  await expect(page.getByTestId("command-palette")).toContainText("ファイル: 保存する");

  await page.getByRole("button", { name: "設定" }).click();
  await expect(page.getByTestId("settings")).toBeVisible();
  await page.getByRole("button", { name: "ダーク" }).click();
  await expect(page.getByTestId("workspace-shell")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: "docs/reports/issue-5-ui/settings-dark.png" });
});

test("Neovim原文ビュー handles plugin screens", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "原文ビュー" }).click();
  await expect(page.getByTestId("raw-grid")).toBeVisible();
  await expect(page.getByTestId("raw-grid")).toContainText("Neovim 原文ビュー");
});

test("read-only demo never simulates save success", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "コマンド" }).click();
  await page.getByTestId("command-palette").getByLabel("コマンドで絞り込む").fill("保存");
  await page.getByRole("button", { name: "ファイル: 保存する" }).click();
  await expect(page.getByRole("alert")).toContainText("ブラウザ表示では編集できません");
  await expect(page.getByTestId("revision")).toHaveText("リビジョン 0");
  await expect(page.getByTestId("dirty")).toHaveText("保存済み");
});
