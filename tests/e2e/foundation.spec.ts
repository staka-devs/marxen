import { expect, test } from "@playwright/test";

// Issue #2 foundation contract, kept green on the Issue #5 shell:
// browser reports disconnection truthfully and stays read-only; it never
// claims a desktop save or a Neovim revision.

test("Japanese shell truthfully reports browser disconnection", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Marxen");
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.getByRole("status")).toHaveText("Neovim 未接続");
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  await expect(page.getByTestId("readonly-note")).toBeVisible();
  await expect(page.getByTestId("revision")).toHaveText("リビジョン 0");
});

test("browser demo is read-only and Unicode-safe", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "メモ/東京.md" }).click();
  const editor = page.locator('[data-testid="editor-primary"] .cm-content');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("東京 😀");
  await expect(editor).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("button", { name: "チェックリストを切り替える" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "保存", exact: true }).first()).toBeDisabled();
});

test("shell remains usable at narrow width", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Marxen" })).toBeAttached();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
