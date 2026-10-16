import { expect, test } from "@playwright/test";

test("multi-root keyboard navigation, image ownership, cancellation and restart in the simulated browser fixture", async ({ page }, testInfo) => {
  await page.route("**/tests/fixtures/pixel.png", (route) => route.abort());
  await page.goto("/tests/live/harness/multi-root.html");
  await page.getByRole("menuitem", { name: "ファイル", exact: true }).click();
  await page.getByRole("menuitem", { name: "フォルダーを開く", exact: true }).click();
  await page.getByRole("button", { name: "same.md", exact: true }).click();
  await expect(page.getByTestId("editor-primary")).toContainText("root-alpha");
  await page.getByRole("menuitem", { name: "ファイル", exact: true }).click();
  await page.getByRole("menuitem", { name: "ワークスペースにフォルダーを追加", exact: true }).click();
  await expect(page.getByTestId("file-tree")).toHaveCount(2);
  await expect(page.getByTestId("editor-primary")).toContainText("root-alpha");
  await page.screenshot({ path: testInfo.outputPath("multi-root-explorer.png") });
  await page.keyboard.press("Control+p");
  await page.getByTestId("quick-open").getByRole("combobox", { name: "ファイル名で絞り込む" }).fill("beta/same.txt");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("editor-primary")).toContainText("root-beta");
  for (const tree of await page.getByTestId("file-tree").all()) await tree.getByRole("button", { name: "same.png", exact: true }).click();
  await expect(page.getByTestId("tabs")).toContainText("alpha/same.png");
  await expect(page.getByTestId("tabs")).toContainText("beta/same.png");
  await expect(page.getByTestId("image-viewer").locator("img")).toBeVisible();
  expect(await page.evaluate(() => window.__multiRootFixture.getCalls())).toContain("image:root-beta:same.png");
  await page.getByRole("button", { name: "/fixture/alpha をワークスペースから取り除く", exact: true }).click();
  await expect(page.getByTestId("remove-root-dialog")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("multi-root-remove-dialog.png") });
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(page.getByTestId("file-tree")).toHaveCount(2);
  await page.reload();
  await expect(page.getByTestId("file-tree")).toHaveCount(2);
  await expect(page.getByTestId("tabs")).toContainText("alpha/same.md");
  await expect(page.getByTestId("image-viewer").locator("img")).toBeVisible();
});

test("root actions remain within a narrow viewport across English, Japanese and regional locales", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/tests/live/harness/multi-root.html");
  await page.getByRole("menuitem", { name: "ファイル", exact: true }).click();
  await page.getByRole("menuitem", { name: "フォルダーを開く", exact: true }).click();
  await page.getByRole("menuitem", { name: "ファイル", exact: true }).click();
  await page.getByRole("menuitem", { name: "ワークスペースにフォルダーを追加", exact: true }).click();
  await expect(page.getByTestId("file-tree")).toHaveCount(2);
  for (const language of ["en-US", "ja-JP", "ja-JP-x-kansai", "ja-JP-x-tokushima"] as const) {
    await page.evaluate((locale) => window.__multiRootFixture.setLanguage(locale), language);
    await page.getByRole("button", { name: language === "en-US" ? "Remove /fixture/beta from workspace" : "/fixture/beta をワークスペースから取り除く", exact: true }).click();
    const dialog = page.getByTestId("remove-root-dialog");
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("file-tree")).toHaveCount(2);
    if (language === "ja-JP") await page.screenshot({ path: testInfo.outputPath("multi-root-narrow.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
});
