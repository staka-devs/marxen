import { describe, expect, it } from "vitest";
import { filterPaths, fuzzyMatch, isSupportedConfigName, outlineFromMarkdown, replaceEdits, searchWorkspace } from "./workspace-content";
import { applyTextEdits } from "./coordinates/utf16";

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
    const { edits, count } = replaceEdits("aaa", "a", "b");
    expect(applyTextEdits("aaa", edits)).toBe("bbb");
    expect(count).toBe(3);
  });

  it("expresses revision-aware replace as ascending range edits", () => {
    const text = "東京\n東京タワー\n";
    const { edits, count } = replaceEdits(text, "東京", "大阪");
    expect(count).toBe(2);
    // Ascending and non-overlapping, applicable against the base revision.
    expect(edits.map((edit) => edit.range.start)).toEqual([0, 3]);
    expect(applyTextEdits(text, edits)).toBe("大阪\n大阪タワー\n");
    expect(replaceEdits(text, "", "x")).toEqual({ edits: [], count: 0 });
  });

  it("accepts dotted and underscore vimrc names", () => {
    for (const name of ["vimrc", "_vimrc", ".vimrc", "init.vim", "init.lua"]) {
      expect(isSupportedConfigName(`/cfg/${name}`)).toBe(true);
    }
    expect(isSupportedConfigName("/cfg/init.toml")).toBe(false);
  });
});
