import { expect, test } from "@playwright/test";

// Production settings components with localStorage only: these checks prove
// browser layout, the protocol dropdown, validation, restart restoration,
// and keyboard behavior — not the OS credential store, native transports,
// real WebView, or IME.

const LOCALES = ["ja-JP", "en-US"] as const;
const WIDTHS = [1280, 360] as const;

/** Resolve locale-specific control labels without inventing catalog keys. */
function labels(locale: "ja-JP" | "en-US") {
  const english = locale === "en-US";
  return {
    add: english ? "Add API" : "API を追加",
    dialog: english ? "Add API connection" : "API 接続先を追加",
    protocol: english ? "Protocol" : "通信形式",
    openai: english ? "OpenAI Chat Completions" : "OpenAI Chat Completions",
    name: english ? "Connection name" : "接続先名",
    endpoint: english ? "API endpoint" : "API エンドポイント",
    model: english ? "Model" : "モデル",
    secret: english ? "Enter credentials" : "資格情報の入力",
    save: english ? "Save" : "保存",
    empty: english ? "No API connections." : "API 接続先がありません。",
    blankName: english ? "Enter a connection name of 1–64 characters." : "接続先名は 1〜64 文字で指定します",
    remove: english ? "Delete" : "削除",
    removeNote: english ? "Delete this connection and its API key." : "接続先と API キーを削除します。",
  };
}

test("named API connections register, validate, persist, and delete across locales and widths", async ({ page }) => {
  test.setTimeout(180_000);
  for (const locale of LOCALES) {
    for (const width of WIDTHS) {
      const text = labels(locale);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/tests/fixtures/settings-preview.html?language=${locale}`);
      await page.evaluate(() => window.localStorage.clear());
      await page.getByRole("button", { name: "Open settings" }).click();
      await page.getByRole("button", { name: "AI", exact: true }).click();
      await expect(page.getByRole("button", { name: text.add })).toBeVisible();
      await expect(page.getByText(text.empty)).toBeVisible();
      await page.getByRole("button", { name: text.add }).click();
      const dialog = page.getByRole("dialog", { name: text.dialog });
      await expect(dialog).toBeVisible();
      const viewport = page.viewportSize()!;
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
      // Empty names never persist.
      await dialog.getByRole("button", { name: text.save, exact: true }).click();
      await expect(dialog.getByText(text.blankName)).toBeVisible();
      // The protocol dropdown offers exactly the two direct-API protocols.
      await dialog.getByRole("combobox", { name: text.protocol }).click();
      const listbox = page.getByRole("listbox");
      await expect(listbox.getByRole("option", { name: text.openai })).toBeVisible();
      await expect(listbox.getByRole("option", { name: "Anthropic Messages" })).toBeVisible();
      const menuBox = (await listbox.boundingBox())!;
      expect(menuBox.x).toBeGreaterThanOrEqual(0);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width + 1);
      await listbox.getByRole("option", { name: "Anthropic Messages" }).click();
      await dialog.getByLabel(text.name).fill("検証用");
      await dialog.getByLabel(text.model).fill("model-verify");
      await dialog.getByLabel(text.secret).fill("s3cret-value");
      await expect(dialog.getByLabel(text.endpoint)).toHaveValue("https://api.anthropic.com/v1");
      await page.screenshot({ path: `test-results/screenshots/issue-79/${locale}-${width}-add.png` });
      await dialog.getByRole("button", { name: text.save, exact: true }).click();
      await expect(page.getByRole("button", { name: /検証用/ })).toBeVisible();
      // Secrets never land in the persisted JSON.
      const stored = await page.evaluate(() => window.localStorage.getItem("marxen.api-connections.v2") ?? "");
      expect(stored).toContain("検証用");
      expect(stored).not.toContain("s3cret-value");
      // Restart restoration keeps the registered connection.
      await page.reload();
      await page.getByRole("button", { name: "Open settings" }).click();
      await page.getByRole("button", { name: "AI", exact: true }).click();
      await expect(page.getByRole("button", { name: /検証用/ })).toBeVisible();
      // Deletion states its credential handling and removes the record.
      await page.getByRole("button", { name: text.remove }).first().click();
      await expect(page.getByText(text.removeNote)).toBeVisible();
      await page.screenshot({ path: `test-results/screenshots/issue-79/${locale}-${width}-delete.png` });
      const confirm = page.getByText(text.removeNote).locator("..");
      await confirm.getByRole("button", { name: text.remove }).click();
      await expect(page.getByRole("button", { name: /検証用/ })).toHaveCount(0);
      await page.reload();
      await page.getByRole("button", { name: "Open settings" }).click();
      await page.getByRole("button", { name: "AI", exact: true }).click();
      await expect(page.getByText(text.empty)).toBeVisible();
      await page.keyboard.press("Escape");
    }
  }
});

test("the add dialog and protocol dropdown stay keyboard operable", async ({ page }) => {
  await page.goto("/tests/fixtures/settings-preview.html");
  await page.evaluate(() => window.localStorage.clear());
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "AI", exact: true }).click();
  const opener = page.getByRole("button", { name: "API を追加" });
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "API 接続先を追加" });
  await expect(dialog).toBeVisible();
  const protocol = dialog.getByRole("combobox", { name: "通信形式" });
  await protocol.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(dialog.getByLabel("API エンドポイント")).toHaveValue("https://api.anthropic.com/v1");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});
