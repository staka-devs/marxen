import { expect, test, type Page } from "@playwright/test";

// Issue #6 live widgets: real inline preview inside CodeMirror.
// The harness mounts ONE CodeMirrorEditor with livePreview and no separate
// preview pane. Meaningful assertions target widgets INSIDE `.cm-content`.

async function harnessValue(page: Page): Promise<string> {
  return page.evaluate(() => window.__harness.getValue());
}

test("widgets render inside one editor, active block stays raw", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/tests/e2e/harness/live.html");
  const content = page.locator(".cm-content");

  await expect(page.locator(".cm-editor")).toHaveCount(1);
  expect(await page.locator('[data-testid="preview"]').count()).toBe(0);

  // Inactive blocks render as widgets inside the editor content.
  await expect(content.locator(".marxen-live-widget table").first()).toBeVisible();
  // The block holding the cursor (heading at offset 0) stays raw source.
  await expect(content.getByText("# ライブ見出し")).toBeVisible();
  expect(await content.locator(".marxen-live-widget h1").count()).toBe(0);

  // Clicking a paragraph widget moves the cursor there: it turns raw while
  // the heading becomes a widget. Raw markers exist only in the active block.
  await content.locator(".marxen-live-widget").getByText("太字").first().click();
  await expect(content.getByText("**太字**")).toBeVisible();
  await expect(content.locator(".marxen-live-widget h1")).toBeVisible();
  expect(await content.getByText("# ライブ見出し").count()).toBe(0);
});

test("task checkbox emits a minimal range edit preserving unrelated bytes", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/tests/e2e/harness/live.html");
  const content = page.locator(".cm-content");
  await expect(content.locator(".marxen-live-widget table").first()).toBeVisible();

  const before = await harnessValue(page);
  const lineStart = before.indexOf("- [ ] 未完了タスク");
  expect(lineStart).toBeGreaterThanOrEqual(0);
  const lineEnd = lineStart + "- [ ] 未完了タスク".length;

  const box = content.locator('.marxen-live-widget li.task-list-item input[type="checkbox"]').first();
  await expect(box).toBeEnabled();
  await box.click();
  await page.waitForFunction(() => window.__harness.getEdits().length > 0);

  const edits = await page.evaluate(() => window.__harness.getEdits());
  expect(edits).toHaveLength(1);
  // One line-level range edit: `- [ ]` -> `- [x]`, nothing else.
  expect(edits[0]).toEqual([{ range: { start: lineStart, end: lineEnd }, text: "- [x] 未完了タスク" }]);

  const after = await harnessValue(page);
  expect(after.slice(0, lineStart)).toBe(before.slice(0, lineStart));
  expect(after.slice(lineEnd)).toBe(before.slice(lineEnd));
  expect(after.slice(lineStart, lineEnd)).toBe("- [x] 未完了タスク");
});

test("table cell click selects the source span; typing preserves neighbours", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/tests/e2e/harness/live.html");
  const content = page.locator(".cm-content");
  await expect(content.locator(".marxen-live-widget table").first()).toBeVisible();

  const before = await harnessValue(page);
  const rowAt = before.indexOf("| 日本語 |");
  expect(rowAt).toBeGreaterThanOrEqual(0);
  const spanStart = before.indexOf("**太字**", rowAt);
  const spanEnd = spanStart + "**太字**".length;

  // Clicking the rendered cell selects its exact source span (escaped pipes
  // and code spans intact elsewhere); the block stays raw for editing.
  const cell = content.locator(".marxen-live-widget td").filter({ hasText: "太字" }).first();
  await cell.click();
  await page.waitForFunction(
    (expected: { anchor: number; head: number }) => {
      const sel = window.__harness.getSelection();
      return sel !== null && sel.anchor === expected.anchor && sel.head === expected.head;
    },
    { anchor: spanStart, head: spanEnd },
    { timeout: 15_000 },
  );

  await page.keyboard.type("更新セル");
  await page.waitForFunction(() => window.__harness.getEdits().length >= 4);

  const edits = await page.evaluate(() => window.__harness.getEdits());
  // Keystrokes arrive as separate transactions; the first one replaces the
  // selected cell span, the rest insert at the cursor. Net effect is one
  // cell replacement with unrelated bytes untouched.
  expect(edits[0]).toEqual([{ range: { start: spanStart, end: spanEnd }, text: "更" }]);

  const after = await harnessValue(page);
  expect(after).toBe(before.slice(0, spanStart) + "更新セル" + before.slice(spanEnd));
  expect(after).toContain("A\\|B");
  expect(after).toContain("`x|y`");
});

test("rapid edits discard stale widget results without leaks", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/tests/e2e/harness/live.html");
  await expect(page.locator(".cm-content .marxen-live-widget table").first()).toBeVisible();

  await page.evaluate(() => {
    window.__harness.setValue("# A\n\ntext A");
    window.__harness.setValue("# B\n\ntext B");
    window.__harness.setValue("# C\n\ntext C");
  });
  const content = page.locator(".cm-content");
  await expect(content.locator(".marxen-live-widget").getByText("text C")).toBeVisible();
  expect(await content.getByText("text A").count()).toBe(0);
  expect(await content.getByText("text B").count()).toBe(0);
  // No rich instances leak from discarded passes.
  expect(await content.locator("canvas").count()).toBe(0);
  expect(await content.locator(".leaflet-container").count()).toBe(0);
  expect(await harnessValue(page)).toBe("# C\n\ntext C");
});

test("malformed blocks stay contained with raw source and errors", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/tests/e2e/harness/live.html");
  const content = page.locator(".cm-content");
  await expect(content.locator(".marxen-live-widget table").first()).toBeVisible();

  const mermaid = content.locator('.marxen-live-widget[data-live-key^="code"]');
  await expect(mermaid.getByText("対応が崩れ")).toBeVisible();
  await expect(mermaid.getByText("A --> [")).toBeVisible();
  // The malformed block never breaks its neighbours.
  await expect(content.locator(".marxen-live-widget table")).toBeVisible();
  await expect(content.locator(".marxen-live-widget").getByText("末尾の段落。")).toBeVisible();
});

test("footnote links jump to definitions and user ids cannot clobber", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/tests/e2e/harness/live.html");
  const content = page.locator(".cm-content");
  await expect(content.locator(".marxen-live-widget table").first()).toBeVisible();

  // Safe prefix on user HTML: no bare id survives to shadow window members.
  await expect(content.locator('.marxen-live-widget [id="marxen-location"]')).toBeVisible();
  expect(await content.locator('.marxen-live-widget [id="location"]').count()).toBe(0);

  const value = await harnessValue(page);
  const defAt = value.indexOf("[^live]:");
  expect(defAt).toBeGreaterThanOrEqual(0);
  const ref = content.locator('.marxen-live-widget a[href^="#marxen-user-content-fn"]').first();
  await expect(ref).toBeVisible();
  await ref.click();
  await page.waitForFunction(
    (expected: number) => {
      const sel = window.__harness.getSelection();
      return sel !== null && sel.anchor === expected && sel.head === expected;
    },
    defAt,
    { timeout: 15_000 },
  );
});
