import { describe, expect, it } from "vitest";
import { serializeVimKey } from "./vim-keys";

describe("Vim key identity", () => {
  it("preserves modifier distinctions and literal less-than input", () => {
    expect(serializeVimKey({ key: "I", ctrlKey: true, shiftKey: true })).toBe("<C-S-i>");
    expect(serializeVimKey({ key: "i", ctrlKey: true })).toBe("<C-i>");
    expect(serializeVimKey({ key: "s", metaKey: true })).toBe("<D-s>");
    expect(serializeVimKey({ key: "Tab", shiftKey: true })).toBe("<S-Tab>");
    expect(serializeVimKey({ key: "<" })).toBe("<LT>");
    expect(serializeVimKey({ key: " " })).toBe(" ");
    expect(serializeVimKey({ key: "Process", ctrlKey: true })).toBeNull();
  });
});
