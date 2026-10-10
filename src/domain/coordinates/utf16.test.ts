import { describe, expect, it } from "vitest";
import { applyTextEdits, isBoundary, lineColToOffset, lineRangeAt, offsetToLineCol } from "./utf16";

describe("utf16 offsets", () => {
  it("never splits surrogate pairs", () => {
    const text = "a😀日本語";
    expect(isBoundary(text, 0)).toBe(true);
    expect(isBoundary(text, 1)).toBe(true);
    expect(isBoundary(text, 2)).toBe(false);
    expect(isBoundary(text, 3)).toBe(true);
    expect(() => offsetToLineCol(text, 2)).toThrow();
  });

  it("maps offsets to lines without byte math", () => {
    const text = "a😀\n日本語\n";
    expect(offsetToLineCol(text, 0)).toEqual({ line: 0, col: 0 });
    expect(lineColToOffset(text, 1, 0)).toBe(4);
    expect(lineRangeAt(text, 5)).toEqual({ start: 4, end: 7, line: "日本語", lineIndex: 1 });
  });

  it("applies ascending non-overlapping edits tail-first", () => {
    expect(applyTextEdits("hello", [{ range: { start: 5, end: 5 }, text: " world" }])).toBe("hello world");
    expect(
      applyTextEdits("abcdef", [
        { range: { start: 0, end: 1 }, text: "A" },
        { range: { start: 2, end: 4 }, text: "CD" },
      ]),
    ).toBe("AbCDef");
  });

  it("rejects empty, reversed, overlapping, and equal-start edits", () => {
    expect(() => applyTextEdits("hi", [])).toThrow();
    expect(() => applyTextEdits("hi", [{ range: { start: 2, end: 1 }, text: "" }])).toThrow();
    expect(() =>
      applyTextEdits("hi", [
        { range: { start: 0, end: 2 }, text: "a" },
        { range: { start: 1, end: 1 }, text: "b" },
      ]),
    ).toThrow();
    expect(() =>
      applyTextEdits("hi", [
        { range: { start: 1, end: 1 }, text: "a" },
        { range: { start: 1, end: 1 }, text: "b" },
      ]),
    ).toThrow();
    expect(() => applyTextEdits("a😀", [{ range: { start: 1, end: 2 }, text: "x" }])).toThrow();
  });
});
