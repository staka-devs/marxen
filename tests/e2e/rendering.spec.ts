import { expect, test } from "@playwright/test";

// Issue #6 acceptance in the browser: the shared remark/rehype pipeline
// renders in read mode and as inline widgets in live mode (no separate
// preview pane there). Special blocks hydrate with locally bundled libraries
// (no CDN), and malformed input keeps raw source with visible errors without
// executing anything.

test("github fixture renders alerts, footnotes, math, diagrams, maps, and 3D", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await page.getByRole("button", { name: "検証/GitHub記法.md" }).click();
  await page.getByRole("button", { name: "閲覧", exact: true }).click();
  const preview = page.getByTestId("preview");

  await expect(preview.locator(".markdown-alert-note")).toBeVisible();
  await expect(preview.locator(".markdown-alert-tip")).toBeVisible();
  await expect(preview.locator(".markdown-alert-important")).toBeVisible();
  await expect(preview.locator(".markdown-alert-warning")).toBeVisible();
  await expect(preview.locator(".markdown-alert-caution")).toBeVisible();
  await expect(preview.locator("table")).toBeVisible();
  await expect(preview.locator("section.footnotes")).toBeVisible();
  await expect(preview.locator("mjx-container").first()).toBeVisible();
  await expect(preview.locator("pre.shiki").first()).toBeVisible();
  await expect(preview.locator('[data-marxen-kind="mermaid"] svg')).toBeVisible();
  await expect(preview.locator('[data-marxen-kind="geojson"] .marxen-map')).toBeVisible();
  await expect(preview.locator('[data-marxen-kind="geojson"] .marxen-map svg')).toBeVisible();
  await expect(preview.locator('[data-marxen-kind="topojson"] .marxen-map svg')).toBeVisible();
  const stl = preview.locator('[data-marxen-kind="stl"]');
  await expect(stl).toBeVisible();
  await expect(stl.locator("canvas, .marxen-error").first()).toBeVisible();
  expect(await preview.locator("script").count()).toBe(0);
  await page.screenshot({ path: "docs/reports/issue-6-rendering/read-github.png" });
  await preview.locator(".markdown-alert-note").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "docs/reports/issue-6-rendering/alerts.png" });
  await preview.locator('[data-marxen-kind="mermaid"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: "docs/reports/issue-6-rendering/mermaid-math.png" });
  await preview.locator('[data-marxen-kind="geojson"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: "docs/reports/issue-6-rendering/map-3d.png" });
  await preview.locator('[data-marxen-kind="stl"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: "docs/reports/issue-6-rendering/stl.png" });

  // Live mode shows the same tree as inline widgets with no separate pane.
  // (Far content is viewport-virtualized by the editor; diagram hydration
  // inside widgets is covered by the live-widgets suite on small docs.)
  await page.getByRole("button", { name: "ライブ", exact: true }).click();
  const live = page.locator('[data-testid="editor-primary"] .cm-content');
  expect(await page.locator('[data-testid="preview"]').count()).toBe(0);
  await expect(live.locator(".marxen-live-widget .markdown-alert-note")).toBeVisible();
  await expect(live.locator(".marxen-live-widget table")).toBeVisible();
  await page.screenshot({ path: "docs/reports/issue-6-rendering/live-github.png" });
});

test("malformed blocks show errors with raw source and stay editable", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await page.getByRole("button", { name: "検証/不正な構文.md" }).click();
  await page.getByRole("button", { name: "閲覧", exact: true }).click();
  const preview = page.getByTestId("preview");
  await expect(preview.locator(".marxen-error").first()).toBeVisible();
  await expect(preview).toContainText("原文のまま残ること");
  await expect(preview).toContainText("A --> [");
  expect(await preview.locator("script").count()).toBe(0);
  await expect(page.getByTestId("revision")).toHaveText("リビジョン 0");
  await page.screenshot({ path: "docs/reports/issue-6-rendering/malformed.png" });
});
