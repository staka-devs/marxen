import { describe, expect, it, vi } from "vitest";
import { hydrateLocalImages, decodeImageSrc, isRelativeImageSrc, isSafeResolvedUrl, type ImageResolver } from "./images";

describe("isRelativeImageSrc", () => {
  it("detects author-relative sources including Unicode names", () => {
    expect(isRelativeImageSrc("images/日本語.png")).toBe(true);
    expect(isRelativeImageSrc("./a/b.jpg")).toBe(true);
    expect(isRelativeImageSrc("../x.gif")).toBe(true);
    expect(isRelativeImageSrc("a.webp")).toBe(true);
  });

  it("leaves absolute, blob, data, and fragment sources alone", () => {
    expect(isRelativeImageSrc("https://example.com/i.png")).toBe(false);
    expect(isRelativeImageSrc("http://example.com/i.png")).toBe(false);
    expect(isRelativeImageSrc("data:image/png;base64,AAA")).toBe(false);
    expect(isRelativeImageSrc("blob:https://x/y")).toBe(false);
    expect(isRelativeImageSrc("#anchor")).toBe(false);
    expect(isRelativeImageSrc("")).toBe(false);
  });

  it("decodes percent-encoded sources back to authored paths", () => {
    expect(decodeImageSrc("images/%E6%97%A5%E6%9C%AC%E8%AA%9E.png")).toBe("images/日本語.png");
    expect(decodeImageSrc("images/a.png")).toBe("images/a.png");
    expect(decodeImageSrc("images/100%.png")).toBe("images/100%.png");
  });
});

describe("isSafeResolvedUrl", () => {
  it("accepts bytes-backed and app-local targets", () => {
    expect(isSafeResolvedUrl("https://example.com/i.png")).toBe(true);
    expect(isSafeResolvedUrl("blob:https://x/y")).toBe(true);
    expect(isSafeResolvedUrl("data:image/png;base64,AAA")).toBe(true);
    expect(isSafeResolvedUrl("data:image/webp;base64,AAA")).toBe(true);
    expect(isSafeResolvedUrl("asset://localhost/img.png")).toBe(true);
  });

  it("rejects executable and foreign targets", () => {
    expect(isSafeResolvedUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeResolvedUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeResolvedUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeResolvedUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeResolvedUrl("C:\\img\\a.png")).toBe(false);
  });
});

function rootWith(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe("hydrateLocalImages", () => {
  it("swaps relative sources through the resolver and skips absolute ones", async () => {
    const resolveImage: ImageResolver = async (src) => (src === "images/a.png" ? "blob:fake-1" : null);
    const resolve = vi.fn(resolveImage);
    const root = rootWith(
      `<p><img src="images/a.png" alt="a"><img src="https://example.com/b.png" alt="b"><img src="images/missing.png" alt="m"></p>`,
    );
    await hydrateLocalImages(root, resolve);
    const [a, b, m] = [...root.querySelectorAll("img")];
    expect(a.getAttribute("src")).toBe("blob:fake-1");
    expect(a.getAttribute("data-marxen-img")).toBe("done");
    expect(b.getAttribute("src")).toBe("https://example.com/b.png");
    expect(b.hasAttribute("data-marxen-img")).toBe(false);
    expect(m.getAttribute("src")).toBe("images/missing.png");
    expect(m.getAttribute("data-marxen-img")).toBe("failed");
    // A second pass never re-resolves finished nodes.
    await hydrateLocalImages(root, resolve);
    expect(resolve).toHaveBeenCalledTimes(2);
    root.remove();
  });

  it("rejects dangerous resolver answers without touching the source", async () => {
    const root = rootWith(`<p><img src="images/a.png" alt="a"></p>`);
    await hydrateLocalImages(root, async () => "javascript:alert(1)");
    const img = root.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("images/a.png");
    expect(img.getAttribute("data-marxen-img")).toBe("failed");
    root.remove();
  });

  it("writes nothing after abort and ignores detached or switched nodes", async () => {
    let release!: (url: string) => void;
    const gate = new Promise<string>((done) => {
      release = done;
    });
    const root = rootWith(`<p><img src="images/slow.png" alt="s"></p>`);
    const controller = new AbortController();
    const pending = hydrateLocalImages(root, () => gate, controller.signal);
    controller.abort();
    release("blob:late");
    await pending;
    expect(root.querySelector("img")!.getAttribute("src")).toBe("images/slow.png");

    // Source switched mid-flight: the late answer belongs to nobody.
    const root2 = rootWith(`<p><img src="images/a.png" alt="a"></p>`);
    const img = root2.querySelector("img")!;
    let release2!: (url: string) => void;
    const gate2 = new Promise<string>((done) => {
      release2 = done;
    });
    const pending2 = hydrateLocalImages(root2, () => gate2);
    img.setAttribute("src", "images/b.png");
    release2("blob:stale");
    await pending2;
    expect(img.getAttribute("src")).toBe("images/b.png");
    root.remove();
    root2.remove();
  });
});
