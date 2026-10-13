import { describe, expect, it } from "vitest";
import { gridLineText, gridLinesFromRedraw } from "./grid";

describe("raw grid parsing", () => {
  it("parses variable-length grid_line cells", () => {
    const params = [
      [
        "grid_line",
        [2, 0, 0, [["日"], ["本", 3], ["語", 0, 2]]],
      ],
    ];
    const lines = gridLinesFromRedraw(params);
    expect(lines).toHaveLength(1);
    expect(gridLineText(lines[0])).toBe("日本語語");
  });

  it("skips non-grid updates", () => {
    expect(gridLinesFromRedraw([[["grid_cursor_goto", 1, 0, 0]]])).toEqual([]);
    expect(gridLinesFromRedraw([["msg_show", ["hi"]]])).toEqual([]);
  });
});
