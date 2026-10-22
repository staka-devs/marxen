import { describe, expect, it } from "vitest";
import { formatRange, insertImage, insertLink, insertTable, isListItemAt, tableAddColumn, tableAddRow, tableDeleteRow, toggleCheckbox } from "./markdown-gui";
import { applyTextEdits } from "./coordinates/utf16";

describe("markdown GUI range patches", () => {
  it("toggles checkboxes without reserializing", () => {
    const text = "- [ ] 買い物\n- [x] 済み\n- 箇条書き\nplain";
    const toggled = applyTextEdits(text, toggleCheckbox(text, 0));
    expect(toggled.startsWith("- [x] 買い物")).toBe(true);
    const untoggled = applyTextEdits(text, toggleCheckbox(text, 10));
    expect(untoggled).toContain("- [ ] 済み");
    const added = applyTextEdits(text, toggleCheckbox(text, 30));
    expect(added).toContain("- [ ] plain");
  });

  it("wraps and unwraps formats", () => {
    const text = "こんにちは世界";
    const bold = applyTextEdits(text, formatRange(text, 5, 7, "bold"));
    expect(bold).toBe("こんにちは**世界**");
    expect(applyTextEdits(bold, formatRange(bold, 5, 11, "bold"))).toBe(text);
    expect(applyTextEdits(text, formatRange(text, 0, 0, "code"))).toBe("``こんにちは世界");
  });

  it("inserts links and images as single range edits", () => {
    expect(applyTextEdits("see ", insertLink("see ", 4, 4, "https://example.com"))).toBe("see [](https://example.com)");
    expect(applyTextEdits("logo", insertImage("logo", 0, 4, "img/logo.png"))).toBe("![logo](img/logo.png)");
  });

  it("inserts tables and edits rows/columns", () => {
    const table = applyTextEdits("", insertTable(0, 1, 2, "見出し"));
    expect(table).toContain("| 見出し | 見出し |");
    const withRow = applyTextEdits(table, tableAddRow(table, 0));
    expect(withRow.split("\n").filter((line) => line.startsWith("|")).length).toBe(4);
    const withCol = applyTextEdits(table, tableAddColumn(table, 0));
    expect(withCol.split("\n")[0].split("|").length).toBeGreaterThan(table.split("\n")[0].split("|").length);
    const afterDelete = applyTextEdits(withRow, tableDeleteRow(withRow, withRow.length - 1));
    expect(afterDelete).toBe(table);
  });

  it("keeps emoji offsets intact", () => {
    const text = "a😀日本語";
    const out = applyTextEdits(text, formatRange(text, 1, 3, "bold"));
    expect(out).toBe("a**😀**日本語");
  });
});

describe("isListItemAt", () => {
  it("detects bullet, ordered and task items but not prose or fenced code", () => {
    const text = "intro\n- a\n  * b\n12. c\n- [ ] d\n```\n- code\n```\n-not";
    /** Offset of the first occurrence of a needle. */
    const at = (needle: string) => text.indexOf(needle);
    expect(isListItemAt(text, at("intro"))).toBe(false);
    expect(isListItemAt(text, at("a"))).toBe(true);
    expect(isListItemAt(text, at("b"))).toBe(true);
    expect(isListItemAt(text, at("c"))).toBe(true);
    expect(isListItemAt(text, at("d"))).toBe(true);
    expect(isListItemAt(text, at("code"))).toBe(false);
    expect(isListItemAt(text, at("not"))).toBe(false);
  });
});
