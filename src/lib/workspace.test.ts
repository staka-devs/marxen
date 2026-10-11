import { describe, expect, it } from "vitest";
import { filterPaths, fuzzyMatch, outlineFromMarkdown, replaceAll, searchWorkspace } from "./workspace";

describe("workspace helpers", () => {
  it("fuzzy-matches Japanese paths for quick-open", () => {
    expect(fuzzyMatch("はじめ", "メモ/はじめに.md")).toBe(true);
    expect(fuzzyMatch("momo", "メモ/はじめに.md")).toBe(false);
    expect(filterPaths(["a.md", "メモ/はじめに.md"], "はじめ")).toEqual(["メモ/はじめに.md"]);
  });

  it("extracts outline skipping fences", () => {
    const text = "# 見出し\n\n```\n# not heading\n```\n\n## 小見出し\n";
    const outline = outlineFromMarkdown(text);
    expect(outline.map((item) => item.title)).toEqual(["見出し", "小見出し"]);
    expect(outline[0].level).toBe(1);
  });

  it("searches and replaces literally", () => {
    const files = [{ path: "a.md", text: "東京\n東京タワー\n大阪" }];
    expect(searchWorkspace(files, "東京")).toHaveLength(2);
    expect(replaceAll("aaa", "a", "b")).toEqual({ text: "bbb", count: 3 });
  });
});
