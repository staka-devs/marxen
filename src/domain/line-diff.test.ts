import { describe, expect, it } from "vitest";
import { lineChanges } from "./line-diff";

describe("lineChanges", () => {
  it("reports nothing for identical text", () => {
    expect(lineChanges("a\nb", "a\nb")).toEqual([]);
  });

  it("marks a rewritten line as added with its original removed", () => {
    expect(lineChanges("# T\nold\nend", "# T\nnew\nend")).toEqual([{ line: 1, added: 1, removed: ["old"] }]);
  });

  it("separates distant insertions and deletions into their own hunks", () => {
    expect(lineChanges("a\nb\nc\nd\ne", "a\nX\nb\nc\ne")).toEqual([
      { line: 1, added: 1, removed: [] },
      { line: 4, added: 0, removed: ["d"] },
    ]);
  });

  it("handles appended and fully replaced documents", () => {
    expect(lineChanges("a", "a\nb\nc")).toEqual([{ line: 1, added: 2, removed: [] }]);
    expect(lineChanges("x\ny", "p\nq\nr")).toEqual([{ line: 0, added: 3, removed: ["x", "y"] }]);
  });
});
