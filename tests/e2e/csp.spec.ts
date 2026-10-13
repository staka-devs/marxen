import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// Enforce the actual desktop policy on the production build, rather than
// checking configuration strings without exercising the renderer.
const config = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const csp: string = config.app.security.csp;

test("production CSP permits local highlighting without enabling JavaScript eval", async ({ page }) => {
  test.setTimeout(90_000);
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(csp).not.toContain("'unsafe-eval'");
  await page.route("**/csp-eval-probe.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: "try { new Function('return 1')(); window.__cspEvalBlocked = false; } catch (error) { window.__cspEvalBlocked = error instanceof EvalError; }",
  }));
  await page.route("**/*", async (route) => {
    if (!route.request().isNavigationRequest()) return route.fallback();
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": csp } });
  });
  await page.goto("/");
  // A same-origin script executes under the page's policy. CDP evaluate
  // itself bypasses CSP, so it cannot prove that JavaScript eval is denied.
  await page.addScriptTag({ url: "/csp-eval-probe.js" });
  expect(await page.evaluate(() => (window as unknown as { __cspEvalBlocked: boolean }).__cspEvalBlocked)).toBe(true);
  await page.getByRole("button", { name: "検証/GitHub記法.md" }).click();
  await page.getByLabel("表示モード").selectOption("read");
  const preview = page.getByTestId("preview");
  await expect(preview.locator("pre.shiki").first()).toBeVisible({ timeout: 20_000 });
  await expect(preview.locator("pre.shiki span[style]").first()).toBeVisible();
  await expect(preview.locator('[data-marxen-kind="mermaid"] svg')).toBeVisible();
  await expect(preview.locator("mjx-container").first()).toBeVisible();
  expect(await page.evaluate(async () => {
    const module = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    return module instanceof WebAssembly.Module;
  })).toBe(true);
  await expect(page.getByTestId("revision")).toHaveText("リビジョン 0");
});
