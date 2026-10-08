import { describe, expect, it } from "vitest";
import { applyGridUpdates, createGridState, gridLineText, gridLinesFromRedraw } from "./grid";

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

describe("persistent Neovim screen", () => {
  it("retains untouched cells and rows across partial redraw batches", () => {
    const initial = applyGridUpdates(createGridState(), [
      ["grid_resize", [1, 5, 2]],
      ["grid_line", [1, 0, 0, [["a", 4], ["b"], ["c"], ["d"], ["e"]]], [1, 1, 0, [["x", 0, 5]]]],
    ]);
    const next = applyGridUpdates(initial, [["grid_line", [1, 0, 2, [["日", 7], [""], ["!"]]]]]);
    expect(next.grids[1].rows[0].map((cell) => cell.text).join("")).toBe("ab日!");
    expect(next.grids[1].rows[1].map((cell) => cell.text).join("")).toBe("xxxxx");
    expect(next.grids[1].rows[0].slice(2).map((cell) => cell.highlight)).toEqual([7, 7, 7]);
    expect(initial.grids[1].rows[0].map((cell) => cell.text).join("")).toBe("abcde");
  });

  it("scrolls a subregion in both directions without corrupting neighbours", () => {
    let state = applyGridUpdates(createGridState(), [
      ["grid_resize", [1, 4, 4]],
      ["grid_line", ...["abcd", "efgh", "ijkl", "mnop"].map((text, row) => [1, row, 0, [...text].map((char) => [char, 0])])],
    ]);
    state = applyGridUpdates(state, [["grid_scroll", [1, 1, 4, 1, 3, 1, 0]]]);
    expect(state.grids[1].rows.map((row) => row.map((cell) => cell.text).join(""))).toEqual(["abcd", "ejkh", "inol", "m  p"]);
    state = applyGridUpdates(state, [["grid_scroll", [1, 1, 4, 1, 3, -1, 0]]]);
    expect(state.grids[1].rows.map((row) => row.map((cell) => cell.text).join(""))).toEqual(["abcd", "e  h", "ijkl", "mnop"]);
  });

  it("retains colors, cursor and highlight identities until explicit replacement", () => {
    const state = applyGridUpdates(createGridState(), [
      ["grid_resize", [1, 3, 2]],
      ["default_colors_set", [0xffffff, 0x222222, 0xff0000, 15, 0]],
      ["hl_attr_define", [7, { foreground: 0x123456, background: 0x654321, reverse: true, bold: true }, {}, []]],
      ["grid_cursor_goto", [1, 1, 2]],
    ]);
    expect(state.colors.foreground).toBe(0xffffff);
    expect(state.highlights[7]).toMatchObject({ foreground: 0x123456, reverse: true, bold: true });
    expect(state.cursor).toEqual({ grid: 1, row: 1, col: 2 });
    const cleared = applyGridUpdates(state, [["grid_clear", [1]], ["busy_start"]]);
    expect(cleared.grids[1].rows[1].map((cell) => cell.text).join("")).toBe("   ");
    expect(cleared.cursor).toEqual(state.cursor);
    expect(cleared.busy).toBe(true);
    const removed = applyGridUpdates(cleared, [["busy_stop"], ["grid_destroy", [1]]]);
    expect(removed.grids[1]).toBeUndefined();
    expect(removed.cursor).toBeNull();
    expect(removed.busy).toBe(false);
  });
});
