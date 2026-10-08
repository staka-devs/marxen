import { expect, test, type Page } from "@playwright/test";

// Issue #6 live widgets: real inline preview inside CodeMirror.
// The harness mounts ONE CodeMirrorEditor with livePreview and no separate
// preview pane. Meaningful assertions target widgets INSIDE `.cm-content`.

async function harnessValue(page: Page): Promise<string> {
  return page.evaluate(() => window.__harness.getValue());
}

/** Park the cursor past the last block so every block renders as a widget. */
async function parkCursorAtEnd(page: Page): Promise<void> {
  await page.evaluate(() => {
    const value = window.__harness.getValue();
    window.__harness.echoCursor(value.length, value.length);
  });
}

test("widgets render inside one editor, active block stays raw", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/tests/live/harness/live.html");
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
  await page.goto("/tests/live/harness/live.html");
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
  await page.goto("/tests/live/harness/live.html");
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
  await page.goto("/tests/live/harness/live.html");
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
  await page.goto("/tests/live/harness/live.html");
  const content = page.locator(".cm-content");
  await expect(content.locator(".marxen-live-widget table").first()).toBeVisible();

  const mermaid = content.locator('.marxen-live-widget[data-live-key^="code"]');
  await expect(mermaid.getByText("対応が崩れ")).toBeVisible();
  await expect(mermaid.getByText("A --> [")).toBeVisible();
  // The malformed block never breaks its neighbours.
  await expect(content.locator(".marxen-live-widget table")).toBeVisible();
  await expect(content.locator(".marxen-live-widget").getByText("末尾の段落。")).toBeVisible();
});

test("insertion before identical tasks keeps toggle offsets exact", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/tests/live/harness/live.html");
  const content = page.locator(".cm-content");
  await expect(content.locator(".marxen-live-widget table").first()).toBeVisible();

  const line = "- [ ] 同じ";
  await page.evaluate(() => window.__harness.setValue("- [ ] 同じ\n\n間\n\n- [ ] 同じ\n"));
  await parkCursorAtEnd(page);
  const boxes = content.locator('.marxen-live-widget li.task-list-item input[type="checkbox"]');
  await expect(boxes).toHaveCount(2);

  // Insert a block before both identical tasks: widgets keep their text but
  // move, so reused DOM must rebind to the new offsets (never the neighbor).
  await page.evaluate(() => window.__harness.setValue("# 新規\n\n- [ ] 同じ\n\n間\n\n- [ ] 同じ\n"));
  await parkCursorAtEnd(page);
  await expect(boxes).toHaveCount(2);
  const value = await harnessValue(page);
  const first = value.indexOf(line);
  const second = value.indexOf(line, first + line.length);
  expect(first).toBeGreaterThanOrEqual(0);
  expect(second).toBeGreaterThan(first);

  await boxes.nth(1).click();
  await page.waitForFunction(() => window.__harness.getEdits().length > 0);

  const edits = await page.evaluate(() => window.__harness.getEdits());
  expect(edits[edits.length - 1]).toEqual([{ range: { start: second, end: second + line.length }, text: "- [x] 同じ" }]);

  const after = await harnessValue(page);
  expect(after.slice(0, second)).toContain("- [ ] 同じ");
  expect(after.slice(second, second + line.length)).toBe("- [x] 同じ");
});

test("repeated identical tables activate the clicked copy only", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/tests/live/harness/live.html");
  const content = page.locator(".cm-content");
  await expect(content.locator(".marxen-live-widget table").first()).toBeVisible();

  const table = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
  await page.evaluate((text: string) => window.__harness.setValue(text), `${table}\n${table}`);
  await parkCursorAtEnd(page);
  const tables = content.locator(".marxen-live-widget table");
  await expect(tables).toHaveCount(2);

  await tables.nth(1).locator("td").first().click();
  const value = await harnessValue(page);
  const firstRow = value.indexOf("| 1 | 2 |");
  const secondRow = value.indexOf("| 1 | 2 |", firstRow + 1);
  // First body cell "1": trimmed content span inside "| 1 | 2 |".
  const expected = { anchor: secondRow + 2, head: secondRow + 3 };
  await page.waitForFunction(
    (want: { anchor: number; head: number }) => {
      const sel = window.__harness.getSelection();
      return sel !== null && sel.anchor === want.anchor && sel.head === want.head;
    },
    expected,
    { timeout: 15_000 },
  );
});

test("moved special blocks dispose and never duplicate hydration", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/tests/live/harness/live.html");
  const content = page.locator(".cm-content");
  await expect(content.locator(".marxen-live-widget table").first()).toBeVisible();

  const geo = '{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[139.7,35.6]}}]}';
  const doc = `# 図あり\n\n\`\`\`mermaid\nflowchart LR\n    A --> B\n\`\`\`\n\n\`\`\`geojson\n${geo}\n\`\`\`\n`;
  await page.evaluate((text: string) => window.__harness.setValue(text), doc);
  await expect(content.locator('.marxen-live-widget [data-marxen-kind="mermaid"] svg')).toBeVisible({ timeout: 60_000 });
  await expect(content.locator('.marxen-live-widget [data-marxen-kind="geojson"] .marxen-map svg')).toBeVisible({ timeout: 60_000 });

  // Move both blocks down: still exactly one hydrated view each, no orphans.
  await page.evaluate((text: string) => window.__harness.setValue(`# 先頭\n\n${text}`), doc);
  await expect(content.locator('.marxen-live-widget [data-marxen-kind="mermaid"] svg')).toBeVisible({ timeout: 60_000 });
  expect(await content.locator('.marxen-live-widget [data-marxen-kind="mermaid"] svg').count()).toBe(1);
  expect(await content.locator(".marxen-live-widget .leaflet-container").count()).toBe(1);

  // Remove both blocks: views are disposed, nothing leaks into the editor.
  await page.evaluate(() => window.__harness.setValue("# 空\n"));
  await expect(content.locator('.marxen-live-widget [data-marxen-kind="mermaid"]')).toHaveCount(0);
  expect(await content.locator(".marxen-live-widget .leaflet-container").count()).toBe(0);
  expect(await content.locator(".cm-content canvas").count()).toBe(0);
});

test("relative images hydrate through the resolver, late bytes are discarded", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/tests/live/harness/live.html");
  const content = page.locator(".cm-content");
  await expect(content.locator(".marxen-live-widget table").first()).toBeVisible();

  await page.evaluate(() => window.__harness.setValue("# 画像\n\n![見る](images/日本語.png)\n\n![欠](images/missing.png)\n"));
  await parkCursorAtEnd(page);
  const seen = content.locator('.marxen-live-widget img[alt="見る"]');
  await expect(seen).toHaveAttribute("src", "data:image/png;base64,aG9uZXk=", { timeout: 30_000 });
  const calls = await page.evaluate(() => window.__harness.imageCalls());
  expect(calls).toContain("images/日本語.png");
  // Unresolvable sources keep their authored path with a failed mark.
  await expect(content.locator('.marxen-live-widget img[alt="欠"]')).toHaveAttribute("data-marxen-img", "failed");

  // Switch documents mid-flight: the slow answer must never land anywhere.
  await page.evaluate(() => window.__harness.setValue("# まず\n\n![遅い](images/slow.png)\n"));
  await page.evaluate(() => window.__harness.setValue("# 空\n"));
  await page.waitForTimeout(1000);
  expect(await content.locator('img[src^="data:image"]').count()).toBe(0);
});

test("shell cursor echoes apply per sequence, never swallowed", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/tests/live/harness/live.html");
  const content = page.locator(".cm-content");
  await expect(content.locator(".marxen-live-widget table").first()).toBeVisible();

  // Two navigation echoes with no edit between them: the old rev-dedup
  // swallowed the second one whenever the revision was unchanged. Echoes are
  // echo-suppressed (no selection callback), so application is observed
  // through widget activation: the echoed block turns raw.
  await page.evaluate(() => window.__harness.echoCursor(5, 5));
  await expect(content.getByText("# ライブ見出し")).toBeVisible();
  await page.evaluate(() => window.__harness.echoCursor(20, 20));
  await expect(content.getByText("**太字**")).toBeVisible();
});

test("footnote links jump to definitions and user ids cannot clobber", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/tests/live/harness/live.html");
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
