import { expect, test, type Page } from "@playwright/test";

/** Compare the drawn caret against browser glyph geometry in the active source line. */
async function caretGeometry(page: Page, line: string, local: number) {
  return page.evaluate(({ line, local }) => {
    const element = [...document.querySelectorAll(".cm-line")].find(node => node.textContent === line);
    if (!element) throw new Error("Active source line is missing");
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    let offset = local;
    while ((node = walker.nextNode())) {
      if (offset < (node.textContent?.length ?? 0)) break;
      offset -= node.textContent?.length ?? 0;
    }
    if (!node) throw new Error("Glyph position is missing");
    const range = document.createRange();
    range.setStart(node, offset);
    const point = range.cloneRange();
    point.collapse(true);
    const width = (node.textContent?.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1;
    range.setEnd(node, offset + width);
    const glyph = range.getBoundingClientRect();
    const start = point.getBoundingClientRect();
    const caret = document.querySelector(".cm-cursor")?.getBoundingClientRect();
    if (!caret) throw new Error("Drawn caret is missing");
    return { dx: caret.left - start.left, dy: caret.top - glyph.top, dh: caret.height - glyph.height, dw: caret.width - glyph.width };
  }, { line, local });
}

test("live caret aligns with actual heading, Unicode, and wrapped glyphs", async ({ page }) => {
  await page.goto("/tests/live/harness/live.html");
  const wrapped = "折り返し文。".repeat(50);
  const text = "# 大きい見出し 😀\n\nEnglish text\n\n日本語 mixed 😀 あいう\n\n" + wrapped + "\n";
  await page.evaluate(text => window.__harness.setValue(text), text);
  await page.evaluate(() => document.fonts.ready);
  for (const width of [1180, 620]) {
    await page.setViewportSize({ width, height: 800 });
    for (const [line, local] of [["# 大きい見出し 😀", 3], ["English text", 4], ["日本語 mixed 😀 あいう", 2], ["日本語 mixed 😀 あいう", 10], [wrapped, 95]] as const) {
      const offset = text.indexOf(line) + local;
      await page.evaluate(offset => { window.__harness.echoCursor(offset, offset); window.__harness.setVimMode("normal"); }, offset);
      await page.locator(".cm-content").focus();
      await expect.poll(async () => {
        const result = await caretGeometry(page, line, local);
        return Math.max(Math.abs(result.dx), Math.abs(result.dy), Math.abs(result.dh), Math.abs(result.dw));
      }).toBeLessThan(1.1);
      await page.evaluate(() => window.__harness.setVimMode("insert"));
      await expect(page.locator(".cm-cursor").first()).toHaveCSS("width", "2px");
      const inserted = await caretGeometry(page, line, local);
      expect(Math.abs(inserted.dx)).toBeLessThan(1.1);
      expect(Math.abs(inserted.dy)).toBeLessThan(1.1);
    }
  }
  expect(await page.evaluate(() => window.__harness.getValue())).toBe(text);
  expect(await page.evaluate(() => window.__harness.getEdits())).toEqual([]);
});
