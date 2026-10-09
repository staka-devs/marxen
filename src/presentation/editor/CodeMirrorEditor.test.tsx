import { describe, expect, it } from "vitest";
import { singleEditFromDiff } from "./CodeMirrorEditor";
import { applyTextEdits } from "../../domain/coordinates/utf16";

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

  it("never splits a surrogate pair at the prefix edge", () => {
    // 😀 (D83D DE00) vs 😃 (D83D DE03) share the high surrogate: the common
    // prefix must retreat so the edit range keeps whole characters.
    const edits = singleEditFromDiff("😀x", "😃x");
    expect(edits).toEqual([{ range: { start: 0, end: 2 }, text: "😃" }]);
    expect(applyTextEdits("😀x", edits!)).toBe("😃x");
  });

  it("never splits a surrogate pair at the suffix edge", () => {
    // Low halves match as "common suffix" while the highs differ: the edit
    // range must swallow the whole pair on both sides (else the Rust side
    // sees a non-char-boundary range).
    const before = "A😀"; // A, D83D, DE00
    const after = "B𠀀"; // B, D840, DC00 -- shares no units, control case
    expect(singleEditFromDiff(before, after)).toEqual([{ range: { start: 0, end: 3 }, text: after }]);
    const trickyBefore = `A${"😀"}`;
    const trickyAfter = `B${"\uD83C\uDE00"}`; // same low half, different high
    expect(singleEditFromDiff(trickyBefore, trickyAfter)).toEqual([
      { range: { start: 0, end: 3 }, text: trickyAfter },
    ]);
    expect(applyTextEdits(trickyBefore, singleEditFromDiff(trickyBefore, trickyAfter)!)).toBe(trickyAfter);
  });

  it("keeps edit ranges on character boundaries around emoji", () => {
    const pairs: Array<[string, string]> = [
      ["東京😀へ", "東京😃へ"],
      ["😀😀", "😀😃"],
      ["a\u{1F600}b", "a\u{1F603}b"],
      ["👨‍👩‍👧", "👨‍👩‍👦"],
    ];
    for (const [before, after] of pairs) {
      const edits = singleEditFromDiff(before, after)!;
      for (const edit of edits) {
        for (const [text, pos] of [[before, edit.range.start], [before, edit.range.end], [after, edit.range.start], [after, edit.range.end]] as const) {
          const atStart = pos === 0 || pos >= text.length;
          const prev = text.charCodeAt(pos - 1);
          const next = text.charCodeAt(pos);
          const split = !atStart && prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
          expect(split).toBe(false);
        }
      }
      expect(applyTextEdits(before, edits)).toBe(after);
    }
  });
});

