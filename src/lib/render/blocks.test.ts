import { describe, expect, it } from "vitest";
import { computeLiveBlocks, extractLinkDefinitions, findTableCellRange } from "./blocks";

describe("computeLiveBlocks", () => {
  it("maps blocks to exact UTF-16 offsets starting at zero", () => {
    const source = "# 見出し 😀\n\n本文 **太字**。\n";
    const blocks = computeLiveBlocks(source);
    expect(blocks[0]).toMatchObject({ kind: "heading", from: 0 });
    expect(source.slice(blocks[0].from, blocks[0].to)).toBe("# 見出し 😀");
    expect(blocks[1].kind).toBe("paragraph");
    expect(source.slice(blocks[1].from, blocks[1].to)).toBe("本文 **太字**。");
  });

  it("keeps offsets exact past emoji and astral characters", () => {
    const source = "😀😀😀\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n";
    const blocks = computeLiveBlocks(source);
    for (const block of blocks) {
      expect(source.slice(block.from, block.to).length).toBe(block.to - block.from);
    }
    const table = blocks.find((block) => block.kind === "table");
    expect(table).toBeDefined();
    expect(source.slice(table!.from, table!.to)).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });

  it("classifies code, math, alerts, and lists", () => {
    const source = "```mermaid\nflowchart LR\n```\n\n$$\nx^2\n$$\n\n> [!TIP]\n> hint\n\n- [ ] task\n";
    const kinds = computeLiveBlocks(source).map((block) => block.kind);
    expect(kinds).toEqual(["code", "math", "alert:tip", "list"]);
    const code = computeLiveBlocks(source)[0];
    expect(code.lang).toBe("mermaid");
  });

  it("excludes footnote definitions from widgets", () => {
    const source = "参照[^a]。\n\n[^a]: 脚注。\n";
    const kinds = computeLiveBlocks(source).map((block) => block.kind);
    expect(kinds).toContain("paragraph");
    expect(kinds).not.toContain("footnoteDefinition");
  });

  it("gives repeated identical blocks distinct exact offsets", () => {
    const line = "# 同じ";
    const source = `${line}\n\n${line}\n`;
    const blocks = computeLiveBlocks(source);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: "heading", from: 0 });
    expect(source.slice(blocks[0].from, blocks[0].to)).toBe(line);
    expect(source.slice(blocks[1].from, blocks[1].to)).toBe(line);
    expect(blocks[1].from).toBe(line.length + 2);
  });
});

describe("extractLinkDefinitions", () => {
  it("collects reference definitions for widget render context", () => {
    const source = "リンクは [GitHub][github]。\n\n[github]: https://github.com \"GitHub\"\n\n[^a]: 脚注。\n";
    const defs = extractLinkDefinitions(source);
    expect(defs).toContain('[github]: https://github.com "GitHub"');
    expect(defs).toContain("[^a]: 脚注。");
  });
});

describe("findTableCellRange", () => {
  const table = "| 項目 | 値 |\n| --- | --- |\n| 日本語 | **太字** |\n| A\\|B | `x|y` |\n";

  it("locates header and body cells with padding preserved", () => {
    const header = findTableCellRange(table, 0, 0, 0);
    expect(header).not.toBeNull();
    expect(table.slice(header!.from, header!.to)).toBe("項目");
    const body = findTableCellRange(table, 0, 1, 1);
    expect(body).not.toBeNull();
    expect(table.slice(body!.from, body!.to)).toBe("**太字**");
  });

  it("honours escaped pipes and code spans", () => {
    const escaped = findTableCellRange(table, 0, 2, 0);
    expect(escaped).not.toBeNull();
    expect(table.slice(escaped!.from, escaped!.to)).toBe("A\\|B");
    const code = findTableCellRange(table, 0, 2, 1);
    expect(code).not.toBeNull();
    expect(table.slice(code!.from, code!.to)).toBe("`x|y`");
  });

  it("returns null out of range", () => {
    expect(findTableCellRange(table, 0, 9, 0)).toBeNull();
    expect(findTableCellRange(table, 0, 0, 9)).toBeNull();
  });
});
