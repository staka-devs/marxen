import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMarkdownBlocks, renderMarkdownDocument } from "./pipeline";

const fixture = (name: string) => readFileSync(join(__dirname, "../../../tests/fixtures", name), "utf8");

describe("render pipeline", () => {
  it("renders GFM tables, tasks, strikethrough, and autolinks", async () => {
    const { html } = await renderMarkdownDocument(
      "| 項目 | 値 |\n| --- | --- |\n| A | B |\n\n- [ ] 未完了\n- [x] 完了\n\n~~取消~~ https://example.com/x\n",
    );
    expect(html).toContain("<table");
    expect(html).toContain("task-list-item");
    expect(html).toContain("checked");
    expect(html).toContain("<del>取消</del>");
    expect(html).toContain('href="https://example.com/x"');
  });

  it("renders all five GitHub alert kinds with icons", async () => {
    const { html } = await renderMarkdownDocument(
      ["> [!NOTE]\n> note", "> [!TIP]\n> tip", "> [!IMPORTANT]\n> important", "> [!WARNING]\n> warning", "> [!CAUTION]\n> caution"].join("\n\n"),
    );
    for (const kind of ["note", "tip", "important", "warning", "caution"]) {
      expect(html).toContain(`markdown-alert-${kind}`);
    }
    expect(html).toContain("<svg");
    expect(html).toContain("octicon");
  });

  it("renders footnotes with consistent link targets", async () => {
    const { html } = await renderMarkdownDocument("参照[^note]。\n\n[^note]: 脚注の本文。\n");
    expect(html).toContain("footnotes");
    expect(html).toContain("脚注の本文");
    // Clobber-prefixed ids stay in lockstep with their fragment links.
    expect(html).toContain('href="#marxen-user-content-fn-note"');
    expect(html).toContain('id="marxen-user-content-fn-note"');
    expect(html).toContain('href="#marxen-user-content-fnref-note"');
    expect(html).toContain('id="marxen-user-content-fnref-note"');
    expect(html).not.toContain('href="#user-content-fn-note"');
  });

  it("highlights code locally with Shiki and keeps unknown languages as text", async () => {
    const { html } = await renderMarkdownDocument("```rust\nfn main() {}\n```\n\n```unknown-language\n<script>alert(1)</script>\n```\n");
    expect(html).toContain('class="shiki');
    expect(html).not.toContain("cdn");
    // Unknown languages fall back to escaped text, never executed markup.
    // (rehype-stringify escapes `<` as &#x3C; and leaves `>` literal.)
    expect(html).toContain("&#x3C;script>alert(1)&#x3C;/script>");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("強調表示には対応していません");
  });

  it("renders valid math with MathJax SVG and keeps malformed math as raw with an error", async () => {
    const valid = await renderMarkdownDocument("インライン $E = mc^2$ と表示数式。\n\n$$\n\\int_0^1 x^2 dx\n$$\n");
    expect(valid.html).toContain("mjx-container");
    expect(valid.diagnostics).toEqual([]);

    const broken = await renderMarkdownDocument("$$\n\\frac{1}{\n$$\n");
    expect(broken.html).toContain("marxen-error");
    expect(broken.html).toContain("frac{1}{");
    expect(broken.diagnostics.some((item) => item.code === "math-invalid")).toBe(true);
  });

  it("sanitizes unsafe HTML while keeping safe details content", async () => {
    const source = fixture("unsafe-html.md");
    const { html } = await renderMarkdownDocument(source);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("onerror");
    // The image itself survives with the handler stripped (GitHub parity).
    expect(html).toContain("missing-image");
    expect(html).toContain("<details");
    expect(html).toContain("この本文は表示できる。");
  });

  it("keeps safe raw HTML allowlist (details/kbd/sub/sup/br)", async () => {
    const { html } = await renderMarkdownDocument("<details>\n<summary>詳細を開く</summary>\n\n本文。\n\n</details>\n\n<kbd>Ctrl</kbd> + <kbd>S</kbd>、<sub>下</sub>、<sup>上</sup>、<br>改行。\n");
    expect(html).toContain("<details");
    expect(html).toContain("<summary>詳細を開く</summary>");
    expect(html).toContain("<kbd>Ctrl</kbd>");
    expect(html).toContain("<sub>下</sub>");
    expect(html).toContain("<sup>上</sup>");
  });

  it("shows errors with raw source for every malformed special block", async () => {
    const source = fixture("malformed-markdown.md");
    const before = source;
    const { html, diagnostics } = await renderMarkdownDocument(source);
    // The pipeline never mutates its input.
    expect(source).toBe(before);
    for (const code of ["mermaid-invalid", "math-invalid", "geojson-invalid", "topojson-invalid", "stl-invalid"]) {
      expect(diagnostics.some((item) => item.code === code)).toBe(true);
    }
    expect(html).toContain("data-invalid=\"true\"");
    // Raw syntax stays visible (escaped) next to each error.
    expect(html).toContain("A --");
    expect(html).toContain("[");
    expect(html).toContain("frac{1}{");
    expect(html).toContain("vertex invalid");
    expect(html).toContain("&#x3C;script>alert(");
    // Editing can continue: the closing paragraph survives.
    expect(html).toContain("Markdownを失わないこと");
  });

  it("builds local placeholders for valid map, 3D, and diagram blocks", async () => {
    const source = fixture("github-markdown.md");
    const { html, diagnostics, blocks } = await renderMarkdownDocument(source);
    expect(diagnostics).toEqual([]);
    for (const kind of ["mermaid", "geojson", "topojson", "stl"]) {
      expect(html).toContain(`data-marxen-kind="${kind}"`);
    }
    expect(html).toContain("marxen-mermaid-output");
    expect(html).toContain("marxen-map");
    expect(html).toContain("marxen-stl");
    expect(html).toContain("コードを表示");
    expect(blocks.some((block) => block.kind === "code:mermaid")).toBe(true);
    expect(blocks.some((block) => block.kind === "table")).toBe(true);
    expect(blocks.some((block) => block.kind === "alert:note")).toBe(true);
  });

  it("emits no CDN or executable markup", async () => {
    const { html } = await renderMarkdownDocument(fixture("github-markdown.md"));
    // xmlns namespaces (http://www.w3.org/...) are inert identifiers, not fetches.
    for (const needle of ["<script", "cdn.jsdelivr", "unpkg.com", "onload=", "onerror=", "javascript:"]) {
      expect(html).not.toContain(needle);
    }
  });

  it("stamps shared source ranges on blocks", async () => {
    const { html, blocks } = await renderMarkdownDocument("# 見出し\n\n本文。\n");
    expect(html).toContain('data-source-start-line="1"');
    expect(blocks[0]).toMatchObject({ kind: "heading", startLine: 1, endLine: 1, title: "見出し" });
    expect(blocks[1]).toMatchObject({ kind: "paragraph", startLine: 3, endLine: 3 });
  });

  it("preserves the original text while rendering the full GitHub fixture", async () => {
    const source = fixture("github-markdown.md");
    const before = source;
    const { html } = await renderMarkdownDocument(source);
    expect(source).toBe(before);
    for (const kind of ["note", "tip", "important", "warning", "caution"]) {
      expect(html).toContain(`markdown-alert-${kind}`);
    }
    expect(html).toContain("footnotes");
    expect(html).toContain("mjx-container");
    expect(html).toContain('class="shiki');
    expect(html).toContain("<table");
  });

  it("never throws on hostile input", async () => {
    const result = await renderMarkdownDocument("<scr<script>ipt>\n\n```\nunterminated");
    expect(typeof result.html).toBe("string");
    expect(result.html).not.toContain("<script>");
  });

  it("prefixes user ids/names so they cannot clobber window properties", async () => {
    const { html } = await renderMarkdownDocument(
      '<h2 id="cookie">見出し</h2>\n\n<a name="location">錨</a>\n\n<a href="#cookie">cookie へ</a>\n\n<img id="name" src="x.png">\n',
    );
    expect(html).toContain('id="marxen-cookie"');
    expect(html).toContain('href="#marxen-cookie"');
    expect(html).toContain('name="marxen-location"');
    expect(html).not.toContain('id="cookie"');
    expect(html).not.toContain('id="location"');
    expect(html).not.toContain('id="name"');
    expect(html).not.toContain('name="location"');
    expect(html).not.toContain('href="#cookie"');
  });

  it("rejects data/vbscript/javascript execution but keeps useful HTML", async () => {
    const { html } = await renderMarkdownDocument(
      '[data](data:text/html,<script>alert(1)</script>)\n\n[vb](vbscript:msgbox(1))\n\n[js](javascript:alert(1))\n\n<img src="data:image/png;base64,iVBORw0KGgo=" alt="貼付画像">\n\n<details><summary>詳細</summary><p>本文。</p></details>\n',
    );
    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain("vbscript:");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(html).toContain("<details");
    expect(html).toContain("本文。");
  });

  it("scrubs executable links from MathJax output", async () => {
    const { html } = await renderMarkdownDocument("数式 $\\href{javascript:alert(1)}{押す}$ を含む。\n");
    expect(html).not.toContain("javascript:");
  });
});

describe("parseMarkdownBlocks", () => {
  it("maps headings, code languages, math, tables, and alerts to lines", () => {
    const blocks = parseMarkdownBlocks("# A\n\n```mermaid\nflowchart LR\n```\n\n> [!TIP]\n> hint\n");
    expect(blocks).toMatchObject([
      { kind: "heading", startLine: 1 },
      { kind: "code:mermaid", startLine: 3 },
      { kind: "alert:tip", startLine: 7 },
    ]);
  });
});
