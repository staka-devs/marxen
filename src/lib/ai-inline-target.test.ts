import { describe, expect, it } from "vitest";
import { resolveInlineTarget } from "./ai-inline-target";

describe("inline target", () => {
  it("targets the explicit selection when present", () => {
    const text = "一段落目。\n\n二段落目。\n\n三段落目。";
    const target = resolveInlineTarget(text, 0, 5);
    expect(target.kind).toBe("selection");
    expect(target.excerpt).toBe(text.slice(0, 5));
  });

  it("targets the current paragraph when the selection is collapsed", () => {
    const text = "一段落目。\n\n二段落目。\n\n三段落目。";
    const caret = text.indexOf("二段落目") + 2;
    const target = resolveInlineTarget(text, caret, caret);
    expect(target.kind).toBe("paragraph");
    expect(target.excerpt).toBe("二段落目。");
  });

  it("keeps surrogate pairs intact at the edges", () => {
    const text = "a😀日本語\n\n次。";
    const target = resolveInlineTarget(text, 0, 2);
    expect(target.excerpt).toBe("a");
    const caret = 1;
    const paragraph = resolveInlineTarget(text, caret, caret);
    expect(paragraph.kind).toBe("paragraph");
    expect(paragraph.excerpt).toContain("a😀日本語");
  });
});
