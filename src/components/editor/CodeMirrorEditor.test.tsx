import { describe, expect, it } from "vitest";
import { singleEditFromDiff } from "./CodeMirrorEditor";
import { applyTextEdits } from "../../lib/utf16";

describe("composition commit", () => {
  it("commits IME text as one range edit", () => {
    const before = "こんにちは";
    const after = "こんにちは日本語";
    const edits = singleEditFromDiff(before, after);
    expect(edits).toEqual([{ range: { start: 5, end: 5 }, text: "日本語" }]);
    expect(applyTextEdits(before, edits!)).toBe(after);
  });

  it("returns null when nothing changed", () => {
    expect(singleEditFromDiff("a😀", "a😀")).toBeNull();
  });
});
