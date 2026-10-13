import { expect, test } from "@playwright/test";

test("Japanese shell truthfully reports browser disconnection", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Marxen");
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.getByRole("status")).toHaveText("Neovim 未接続");
  await expect(page.getByText("ブラウザ表示です。デスクトップの Neovim には接続していません。")).toBeVisible();
  await expect(page.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
});

test("CodeMirror sample is read-only, Unicode-safe, and can be closed", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "サンプルを表示" }).click();
  const sample = page.getByRole("textbox", { name: "読み取り専用の Markdown サンプル" });
  await expect(sample).toHaveAttribute("contenteditable", "false");
  await expect(sample).toHaveAttribute("aria-readonly", "true");
  await expect(sample).toContainText("東京 😀");
  const before = await sample.textContent();
  await sample.focus();
  await page.keyboard.type("fake Vim input");
  await page.keyboard.press("Escape");
  await expect(sample).toHaveText(before!);
  await page.getByRole("button", { name: "サンプルを閉じる" }).click();
  await expect(sample).toHaveCount(0);
});

test("shell remains usable at narrow width", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
