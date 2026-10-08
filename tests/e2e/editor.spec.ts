import { expect, test, type Page } from "@playwright/test";

// Issue #5 acceptance in the browser: the demo is read-only (real Neovim
// paths are covered by Rust integration tests and mocked Vitest flows).
// E2E asserts mode retention, invalid-fixture safety, navigation UI, and
// that no save success or revision bump is ever simulated. Live uses true
// inline widgets inside .cm-content (no separate preview); read uses the
// shared read preview.

async function setViewMode(page: Page, mode: string) {
  await page.getByLabel("表示モード").selectOption(mode);
}

test("live/source/read/split retain the document without editing it", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("revision")).toHaveText("リビジョン 0");
  // Live owns the inline preview: editor stays, separate preview is absent.
  await expect(page.locator('[data-testid="editor-primary"] .cm-content')).toBeVisible();
  await expect(page.getByTestId("preview")).toHaveCount(0);

  await setViewMode(page, "read");
  await expect(page.getByTestId("preview")).toContainText("日本語で書く");
  const before = await page.getByTestId("preview").textContent();

  await setViewMode(page, "source");
  await expect(page.locator('[data-testid="editor-primary"] .cm-content')).toBeVisible();

  await setViewMode(page, "split");
  await expect(page.locator('[data-testid="editor-secondary"] .cm-content')).toBeVisible();

  await setViewMode(page, "live");
  await expect(page.locator('[data-testid="editor-primary"] .cm-content')).toBeVisible();
  await expect(page.getByTestId("preview")).toHaveCount(0);
  await expect(page.getByTestId("revision")).toHaveText("リビジョン 0");

  await setViewMode(page, "read");
  await expect(page.getByTestId("preview").textContent()).resolves.toBe(before);

  await setViewMode(page, "live");
  await page.screenshot({ path: "docs/reports/issue-5-ui/live.png" });
  await setViewMode(page, "read");
  await page.screenshot({ path: "docs/reports/issue-5-ui/read.png" });
  await setViewMode(page, "source");
  await page.screenshot({ path: "docs/reports/issue-5-ui/source.png" });
  await setViewMode(page, "split");
  await page.screenshot({ path: "docs/reports/issue-5-ui/split.png" });
});

test("invalid fixtures render safely without executing", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    (window as unknown as { __marxenUnsafe?: boolean }).__marxenUnsafe = false;
  });

  await page.getByRole("button", { name: "検証/安全でないHTML.md" }).click();
  await setViewMode(page, "read");
  const preview = page.getByTestId("preview");
  await expect(preview).toContainText("この本文は表示できる。");
  expect(await preview.locator("script").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __marxenUnsafe?: boolean }).__marxenUnsafe)).toBe(false);

  await page.getByRole("button", { name: "検証/不正な構文.md" }).click();
  await setViewMode(page, "read");
  await expect(page.getByTestId("preview")).toContainText("原文のまま残ること");
  await expect(page.getByTestId("revision")).toHaveText("リビジョン 0");
});

test("tree/tabs/quick-open/search/outline/palette/themes work in Japanese", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("file-tree")).toContainText("メモ/はじめに.md");
  await page.getByRole("button", { name: "メモ/東京.md" }).click();
  await expect(page.getByTestId("tabs")).toContainText("東京.md");

  await page.getByRole("button", { name: "その他の操作" }).click();
  await page.getByRole("menuitem", { name: "クイックオープン" }).click();
  await expect(page.getByTestId("quick-open")).toBeVisible();
  await page.getByTestId("quick-open").getByLabel("ファイル名で絞り込む").fill("はじめ");
  await expect(page.getByTestId("quick-open")).toContainText("メモ/はじめに.md");
  await page.getByTestId("quick-open").getByRole("button", { name: "閉じる (Esc)" }).click();

  await page.getByRole("button", { name: "検索", exact: true }).click();
  await expect(page.getByTestId("search-panel")).toBeVisible();
  await page.getByTestId("search-panel").getByLabel("検索語句").fill("東京");
  await expect(page.getByTestId("search-panel")).toContainText("件");

  await page.getByRole("button", { name: "アウトライン", exact: true }).click();
  await expect(page.getByTestId("outline")).toBeVisible();

  await page.getByRole("button", { name: "その他の操作" }).click();
  await page.getByRole("menuitem", { name: "コマンドパレット" }).click();
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.screenshot({ path: "docs/reports/issue-5-ui/palette.png" });
  await page.getByTestId("command-palette").getByLabel("コマンドで絞り込む").fill("保存");
  await expect(page.getByTestId("command-palette")).toContainText("ファイル: 保存する");

  await page.getByRole("button", { name: "設定表示切替" }).click();
  await expect(page.getByTestId("settings")).toBeVisible();
  await page.getByRole("button", { name: "ライト" }).click();
  await expect(page.getByTestId("workspace-shell")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "ダーク" }).click();
  await expect(page.getByTestId("workspace-shell")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: "docs/reports/issue-5-ui/settings-dark.png" });
});

test("Neovim原文ビュー handles plugin screens", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "その他の操作" }).click();
  await page.getByRole("menuitem", { name: "原文ビュー" }).click();
  const raw = page.getByTestId("raw-grid");
  await expect(raw).toBeVisible();
  await expect(raw).toHaveAttribute("role", "textbox");
});

test("read-only demo never simulates save success", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "その他の操作" }).click();
  await page.getByRole("menuitem", { name: "コマンドパレット" }).click();
  await page.getByTestId("command-palette").getByLabel("コマンドで絞り込む").fill("保存");
  await page.getByRole("button", { name: "ファイル: 保存する" }).click();
  await expect(page.getByRole("alert")).toContainText("ブラウザ表示では編集できません");
  await expect(page.getByTestId("revision")).toHaveText("リビジョン 0");
  await expect(page.getByTestId("dirty")).toHaveText("保存済み");
});

test("clean chrome at laptop sizes with no body scrollbar", async ({ page }) => {
  for (const [width, height, name] of [[1493, 1047, "clean-1493"], [1280, 800, "clean-1280"]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    // Live keeps the editor canvas; read keeps the preview. Either way the
    // fixed 100dvh shell scrolls internally with no page-level scrollbar.
    await expect(page.locator('[data-testid="editor-primary"] .cm-content')).toBeVisible();
    expect(await page.evaluate(() => document.body.scrollHeight <= window.innerHeight + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    // Slender rail, single sidebar, compact tabs, single canvas, slim status.
    expect(await page.evaluate(() => document.querySelector("nav[aria-label='アクティビティ']")?.clientWidth ?? 999)).toBeLessThan(60);
    await page.screenshot({ path: `docs/reports/issue-5-ui/${name}.png` });
  }
});
