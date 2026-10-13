import { describe, expect, it } from "vitest";
import { adjacentTableCell, hardBreakSpaces, splitTableRowCells, tableAddColumn, tableAddRow, tableAlignColumn, tableCellAt, tableDeleteColumn, tableDeleteRow } from "./markdown-gui";
import { applyTextEdits } from "./coordinates/utf16";

const table = "before\n\n| A | B | C |\n| :--- | ---: | :---: |\n| A\\|B | ``x`|y`` | ---data |\n| one | two | three |\n\nafter";
const at = table.indexOf("``x");

describe("table edits at the selected source cell", () => {
  it("keeps escaped pipes and exact code runs inside cells", () => {
    const line = "  | A\\|B | ``x`|y`` | tail |  ";
    expect(splitTableRowCells(line).map((span) => line.slice(span.start, span.end).trim())).toEqual(["A\\|B", "``x`|y``", "tail"]);
    expect(tableCellAt(table, at)).toMatchObject({ column: 1, columns: 3, alignment: "right" });
  });
  it.each(["above", "below"] as const)("inserts a row %s without splitting the header and delimiter", (position) => {
    const result = applyTextEdits(table, tableAddRow(table, at, position));
    expect(result).toContain(position === "above" ? "|  |  |  |\n| A\\|B" : "---data |\n|  |  |  |");
    expect(applyTextEdits(table, tableAddRow(table, table.indexOf("| A |"), position))).toContain("| :--- | ---: | :---: |\n|  |  |  |");
  });
  it("adds left/right columns at the selected cell and only treats the delimiter as structural", () => {
    const left = applyTextEdits(table, tableAddColumn(table, at, "left"));
    const right = applyTextEdits(table, tableAddColumn(table, at, "right"));
    expect(left).toContain("| A\\|B |  | ``x`|y`` | ---data |");
    expect(right).toContain("| A\\|B | ``x`|y`` |  | ---data |");
    expect(left).toContain("| :--- | --- | ---: | :---: |");
    expect(tableCellAt(left, left.indexOf("``x"))?.columns).toBe(4);
  });
  it("deletes a selected column without changing other cell bytes", () => {
    const result = applyTextEdits(table, tableDeleteColumn(table, at));
    expect(result).toContain("| A\\|B | ---data |");
    expect(result).toContain("| :--- | :---: |");
    expect(result.startsWith("before\n\n")).toBe(true);
    expect(result.endsWith("\n\nafter")).toBe(true);
    expect(applyTextEdits("| H |\n| --- |\n| x |", tableDeleteColumn("| H |\n| --- |\n| x |", 0))).toBe("");
  });
  it.each(["left", "center", "right", "none"] as const)("sets only the selected column alignment to %s", (alignment) => {
    const result = applyTextEdits(table, tableAlignColumn(table, at, alignment));
    expect(tableCellAt(result, result.indexOf("``x"))?.alignment).toBe(alignment);
    expect(result.slice(result.indexOf("| A\\|B"))).toBe(table.slice(table.indexOf("| A\\|B")));
  });
  it("preserves the header, deletes only a data row, and handles an unterminated last row", () => {
    expect(() => tableDeleteRow(table, table.indexOf("| A |"))).toThrow();
    expect(applyTextEdits(table, tableDeleteRow(table, at))).not.toContain("A\\|B");
    const last = "| H |\n| --- |\n| x |";
    expect(applyTextEdits(last, tableAddRow(last, last.indexOf("x"), "below"))).toBe(last + "\n|  |");
  });
  it("navigates cells across data rows while skipping the delimiter", () => {
    const next = adjacentTableCell(table, table.indexOf(" C |"), false)!;
    expect(table.slice(next.anchor, next.head)).toBe("A\\|B");
    const prior = adjacentTableCell(table, at, true)!;
    expect(table.slice(prior.anchor, prior.head)).toBe("A\\|B");
    expect(adjacentTableCell(table, table.indexOf(" A |"), true)).toBeNull();
  });
});

describe("Markdown hard-break prose rule", () => {
  it.each([["日本😀", "  "], ["prose ", " "], ["prose  ", ""], ["prose   ", ""], ["prose\\", ""]])("adds only necessary spaces after %s", (text, spaces) => {
    expect(hardBreakSpaces(text, text.length, text.length)).toBe(spaces);
  });
  it.each(["", "   ", "# Heading", "---", "- ", "    code", "```ts\ncode", "~~~\ncode", "```\ncode\n```", "> ```\n> code", "| A |\n| --- |\n| x |"])("keeps empty or structural/code line %j unchanged", (text) => {
    expect(hardBreakSpaces(text, text.length, text.length)).toBeNull();
  });
  it("keeps mid-line and selected replacement Enter unchanged and resumes prose after a closed fence", () => {
    expect(hardBreakSpaces("abcdef", 2, 2)).toBeNull();
    expect(hardBreakSpaces("abcdef", 2, 6)).toBeNull();
    const text = "~~~\ncode\n~~~\nprose";
    expect(hardBreakSpaces(text, text.length, text.length)).toBe("  ");
  });
});
