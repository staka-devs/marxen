import { expect, it, vi } from "vitest";
import { markdownToPlainText, prepareClipboard } from "./clipboard";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

it("keeps Markdown bytes and removes syntax only for the plain-text format", async () => {
  const source = "# 日本 😀\n\n**太字**と[リンク](https://example.com)\n\n```rust\nlet a = \"*exact*\";\n```\n";
  expect(await prepareClipboard({ format: "markdown", text: source })).toEqual({ text: source, html: null, rtf: null });
  expect(markdownToPlainText(source)).toBe('日本 😀\n\n太字とリンク\n\nlet a = "*exact*";\n');
});

it("retains GFM table order, checked tasks, image alt and TeX", () => {
  const source = "- [x] done\n- [ ] next\n\n| A | B |\n| - | - |\n| 日本 | 😀 |\n\n![説明](image.png) $x^2$";
  expect(markdownToPlainText(source)).toBe("[x] done\n[ ] next\n\nA\tB\n日本\t😀\n\n説明 x^2");
});

it("rich text carries sanitized HTML and an undecorated text alternative", async () => {
  const source = "# Hello\n\n**bold** <img src=x onerror=alert(1)><script>bad()</script>\n\n|A|B|\n|-|-|\n|1|2|";
  const payload = await prepareClipboard({ format: "rich", text: source });
  expect(payload.html).toContain("<strong>bold</strong>");
  expect(payload.html).toContain("border-collapse: collapse");
  expect(payload.html).not.toMatch(/onerror|<script|bad\(\)/);
  expect(payload.text).toContain("Hello\n\nbold");
  expect(payload.text).not.toContain("bad()");
  const htmlSource = await prepareClipboard({ format: "html", text: source });
  expect(htmlSource).toEqual({ text: payload.html, html: null, rtf: null });
});

it("embeds two relative PNG images into HTML and RTF in document order", async () => {
  // A valid 1x1 PNG; the export embeds its bytes rather than filesystem URLs.
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";
  const resolve = vi.fn(async (_path: string) => `data:image/png;base64,${png}`);
  const payload = await prepareClipboard({ format: "rich", text: "先 😀 ![一](日本.png) 後 ![二](images/two.png)" }, resolve);
  expect(resolve.mock.calls.map((call) => call[0])).toEqual(["日本.png", "images/two.png"]);
  expect(payload.html?.match(/src="data:image\/png;base64,/g)).toHaveLength(2);
  expect(payload.rtf?.match(/\\pict\\pngblip/g)).toHaveLength(2);
  expect(payload.rtf).toContain("\\picw1\\pich1");
  expect(payload.rtf).toContain("89504e470d0a1a0a");
  expect(payload.rtf).toContain("\\u-10179?\\u-8704?");
  expect(payload.rtf).not.toContain("日本.png");
  await expect(prepareClipboard({ format: "rich", text: "![欠落](missing.png)" }, async () => null)).rejects.toThrow("画像をコピーできません");
});

it("retains formula text, hyperlink destinations and ordered list numbers in RTF", async () => {
  const payload = await prepareClipboard({ format: "rich", text: 'before $x^2$ after [link](https://example.com/a?b=1)\n\n3. third\n4. fourth\n\n- bullet' });
  expect(payload.rtf).toContain("before x^2 after");
  expect(payload.rtf).toContain('HYPERLINK "https://example.com/a?b=1"');
  expect(payload.rtf).toContain("3.\\tab third");
  expect(payload.rtf).toContain("4.\\tab fourth");
  expect(payload.rtf).toContain("\\bullet\\tab bullet");
});
