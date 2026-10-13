import { expect, test } from "@playwright/test";

// Production components, mocked Vim gateway: these checks prove browser layout,
// keyboard behavior and localStorage, not real Neovim mappings or native WebView/IME.

test("settings and mapping rows fit wide/narrow viewports across all themes and base locales", async ({ page }) => {
  test.setTimeout(120_000);
  for (const locale of ["ja-JP", "en-US"]) {
    for (const width of [1280, 360]) {
      for (const theme of ["dark", "light", "contrast"]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/tests/fixtures/settings-preview.html?language=${locale}`);
        await page.getByRole("button", { name: "Open settings" }).click();
        const dialog = page.getByRole("dialog");
        const themeSelect = dialog.getByLabel(locale === "en-US" ? "Color theme" : "カラーテーマ");
        await themeSelect.selectOption(theme);
        await expect(dialog.getByLabel(locale === "en-US" ? "Font size" : "文字サイズ")).toBeVisible();
        await expect(dialog.getByLabel(locale === "en-US" ? "Notification position" : "通知の表示位置")).toHaveValue("bottom-right");
        await page.screenshot({ path: `test-results/screenshots/issue-70/${locale}-${theme}-${width}-overview.png` });
        await dialog.getByRole("button", { name: "Vim", exact: true }).click();
        const mode = dialog.getByLabel(locale === "en-US" ? "Mapping 1 mode" : "マッピング1のモード");
        await expect(mode).toHaveValue("n");
        expect((await mode.boundingBox())!.width).toBeGreaterThan(100);
        const content = page.getByTestId("settings-content");
        expect(await content.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        const search = dialog.getByLabel(locale === "en-US" ? "Search settings" : "設定を検索");
        const searchBefore = await search.boundingBox();
        await content.evaluate((element) => { element.scrollTop = element.scrollHeight; });
        expect(await search.boundingBox()).toEqual(searchBefore);
        const actions = page.getByTestId("vim-settings-actions");
        await expect(actions).toBeInViewport();
        const actionBox = (await actions.boundingBox())!;
        const contentBox = (await content.boundingBox())!;
        expect(actionBox.y).toBeGreaterThanOrEqual(contentBox.y);
        expect(actionBox.y).toBeLessThan(contentBox.y + 32);
        await content.evaluate((element) => { element.scrollTop = 0; });
        await dialog.getByLabel(locale === "en-US" ? "Leader key" : "リーダーキー", { exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: `test-results/screenshots/issue-70/${locale}-${theme}-${width}-leader.png` });
        await mode.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `test-results/screenshots/issue-70/${locale}-${theme}-${width}-vim.png` });
        const optionColors = await mode.evaluate((element) => {
          const select = getComputedStyle(element);
          const option = getComputedStyle(element.querySelector("option")!);
          return { text: option.color, background: option.backgroundColor, scheme: select.colorScheme };
        });
        expect(optionColors.text).not.toBe(optionColors.background);
        expect(optionColors.scheme).toBe(theme === "dark" ? "dark" : "light");
      }
    }
  }
});

test("Space/common/custom leader, focus and every persisted notification position work in the browser fixture", async ({ page }) => {
  await page.goto("/tests/fixtures/settings-preview.html");
  const opener = page.getByRole("button", { name: "Open settings" });
  await opener.click();
  await expect(page.getByLabel("設定を検索")).toBeFocused();
  await page.getByRole("button", { name: "Vim", exact: true }).click();
  const common = page.getByLabel("よく使うリーダーキー");
  const leader = page.getByLabel("リーダーキー", { exact: true });
  await expect(leader).toHaveValue("<Space>");
  await common.focus(); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  await expect(common).toHaveValue("\\");
  for (const key of ["\\", ",", ";", " "]) {
    await common.selectOption(key);
    await expect(leader).toHaveValue(key === " " ? "<Space>" : key);
  }
  await common.selectOption("custom"); await expect(leader).toBeFocused();
  await leader.fill("<space>"); await expect(leader).toHaveValue("<Space>");
  await expect(page.getByTestId("vim-settings-preview")).toContainText('let mapleader=" "');
  await leader.fill("界"); await expect(common).toHaveValue("custom");
  await page.getByRole("button", { name: "管理ブロックを保存する" }).click();
  await expect(page.getByTestId("vim-settings-preview")).toContainText('let mapleader="界"');
  await page.getByRole("button", { name: "Vim詳細設定を再読込する" }).click();
  await expect(leader).toHaveValue("界");
  const first = page.getByRole("button", { name: "設定を閉じる" });
  await first.focus(); await page.keyboard.press("Shift+Tab");
  await expect(page.getByLabel("Vim設定ファイルの設定コード")).toBeFocused();
  await page.keyboard.press("Tab"); await expect(first).toBeFocused();
  await page.keyboard.press("Escape"); await expect(opener).toBeFocused();
  for (const position of ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"]) {
    await opener.click(); await page.getByRole("button", { name: "通知", exact: true }).click();
    await page.getByLabel("通知の表示位置").selectOption(position);
    await page.keyboard.press("Escape");
    await page.reload();
    const editor = page.getByLabel("Fixture editor"); await editor.focus();
    const before = await editor.boundingBox();
    await page.getByRole("button", { name: "Info", exact: true }).evaluate((element: HTMLElement) => element.click());
    await page.getByRole("button", { name: "Recovery", exact: true }).evaluate((element: HTMLElement) => element.click());
    await expect(editor).toBeFocused(); expect(await editor.boundingBox()).toEqual(before);
    const toast = page.getByTestId("notification-toast");
    await expect(toast).toHaveAttribute("data-position", position);
    const box = (await toast.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(position.startsWith("top") ? box.y : viewport.height - box.y - box.height).toBeCloseTo(32, 0);
    if (position.endsWith("center")) expect(box.x + box.width / 2).toBeCloseTo(viewport.width / 2, 0);
    else expect(position.endsWith("left") ? box.x : viewport.width - box.x - box.width).toBeCloseTo(16, 0);
    await page.getByRole("button", { name: "Error", exact: true }).evaluate((element: HTMLElement) => element.click());
    await expect(toast).toHaveAttribute("role", "alert");
    await expect(editor).toBeFocused(); expect(await editor.boundingBox()).toEqual(before);
    await expect(page.getByTestId("recovery-toast")).toHaveAttribute("data-position", position);
    await page.screenshot({ path: `test-results/screenshots/issue-70/toasts-${position}.png` });
    await toast.getByRole("button", { name: "通知を閉じる" }).click();
    await page.getByTestId("recovery-toast").getByRole("button", { name: "通知を閉じる" }).click();
  }
});

test("new settings labels conservatively fall back to Japanese in regional locales", async ({ page }) => {
  for (const language of ["ja-JP-x-kansai", "ja-JP-x-tokushima"]) {
    await page.goto(`/tests/fixtures/settings-preview.html?language=${language}`);
    await page.getByRole("button", { name: "Open settings" }).click();
    await expect(page.getByLabel("通知の表示位置")).toBeVisible();
    await page.getByRole("button", { name: "Vim", exact: true }).click();
    await expect(page.getByLabel("よく使うリーダーキー")).toBeVisible();
    await expect(page.getByRole("option", { name: "Space（スペース）", exact: true })).toHaveCount(1);
  }
});
