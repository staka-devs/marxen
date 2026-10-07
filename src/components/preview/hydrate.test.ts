import { describe, expect, it } from "vitest";
import { disposeMarkdownView, hydrateMarkdownView, sanitizeSvg } from "./hydrate";

describe("sanitizeSvg", () => {
  it("keeps shapes while dropping scripts, handlers, and executable links", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><g onclick="evil()" onload="evil()"><rect width="10" height="10"/><a href="javascript:alert(1)"><text>押す</text></a><a href="https://example.com">安全</a></g></svg>`;
    const clean = sanitizeSvg(svg);
    expect(clean).toContain("<rect");
    expect(clean).toContain('href="https://example.com"');
    expect(clean).not.toContain("<script");
    expect(clean).not.toContain("onclick");
    expect(clean).not.toContain("onload");
    expect(clean).not.toContain("javascript:");
  });

  it("drops vbscript and data targets from xlink hrefs", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="vbscript:msgbox(1)">x</a><a xlink:href="data:text/html,hi">y</a></svg>`;
    const clean = sanitizeSvg(svg);
    expect(clean).not.toContain("vbscript:");
    expect(clean).not.toContain("data:text/html");
  });

  it("returns empty for unparseable input", () => {
    expect(sanitizeSvg("not <svg at all <")).toBe("");
  });
});

describe("hydration lifecycles", () => {
  it("writes nothing and resolves when already aborted", async () => {
    const root = document.createElement("div");
    root.innerHTML = `<div class="marxen-special" data-marxen-kind="mermaid"><div class="marxen-mermaid-output"></div><details class="marxen-source"><summary>原文を表示</summary><pre><code>flowchart LR\n    A --&gt; B</code></pre></details></div>`;
    const controller = new AbortController();
    controller.abort();
    await hydrateMarkdownView(root, controller.signal);
    expect(root.querySelector(".marxen-mermaid-output")!.innerHTML).toBe("");
    expect(root.querySelector("[data-hydrated]")).toBeNull();
  });

  it("dispose is idempotent on pristine trees", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div class="marxen-special" data-marxen-kind="stl"><div class="marxen-stl"></div></div>`;
    expect(() => {
      disposeMarkdownView(root);
      disposeMarkdownView(root);
    }).not.toThrow();
  });
});
