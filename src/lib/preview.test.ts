import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderMarkdownPreview } from "./preview";

const fixture = (name: string) => readFileSync(join(__dirname, "../../tests/fixtures", name), "utf8");

describe("preview renderer", () => {
  it("renders Japanese headings, checkboxes, and tables", () => {
    const html = renderMarkdownPreview("# 東京 😀\n\n- [ ] 買い物\n\n| 項目 | 状態 |\n| --- | --- |\n| 原文 | 保持 |\n");
    expect(html).toContain("<h1>東京 😀</h1>");
    expect(html).toContain('type="checkbox" disabled');
    expect(html).toContain("<table>");
  });

  it("sanitizes raw HTML and javascript URLs", () => {
    const html = renderMarkdownPreview('<script>alert(1)</script>\n\n[x](javascript:alert(1))\n');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("javascript:");
  });

  it("renders invalid fixtures without executing them", () => {
    const malformed = fixture("malformed-markdown.md");
    const malformedHtml = renderMarkdownPreview(malformed);
    expect(malformedHtml).toContain("不正な構文でも編集を続けられるサンプル");
    expect(malformedHtml).not.toContain("<script>alert");

    const unsafe = fixture("unsafe-html.md");
    const unsafeHtml = renderMarkdownPreview(unsafe);
    expect(unsafeHtml).not.toContain("<script>");
    expect(unsafeHtml).not.toContain("<img");
    expect(unsafeHtml).not.toContain("<iframe");
    expect(unsafeHtml).not.toContain('href="javascript:');
    expect(unsafeHtml).toContain("この本文は表示できる。");
  });
});
