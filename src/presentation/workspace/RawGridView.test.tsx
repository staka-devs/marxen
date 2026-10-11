import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { applyGridUpdates, createGridState } from "../../domain/coordinates/grid";
import { RawGridView } from "./RawGridView";

describe("native Neovim screen", () => {
  it("keeps wide cells aligned and moves the native cursor without changing document text", () => {
    const initial = applyGridUpdates(createGridState(), [
      ["grid_resize", [1, 5, 1]],
      ["default_colors_set", [0xffffff, 0x000000, 0xffffff]],
      ["hl_attr_define", [2, { foreground: 0x123456, bold: true }, {}, []]],
      ["grid_line", [1, 0, 0, [["日", 2], [""], ["a"], [" ", 0, 2]]]],
      ["grid_cursor_goto", [1, 0, 2]],
    ]);
    const { container, rerender } = render(<RawGridView text="unchanged" grid={initial} />);
    expect(screen.getByTestId("nvim-screen").textContent).toBe("日a  ");
    const wide = screen.getByText("日");
    expect(wide.style.gridColumn).toBe("1 / span 2");
    expect(wide.style.fontWeight).toBe("700");
    expect(container.querySelector("[data-nvim-cursor]")?.textContent).toBe("a");
    const moved = applyGridUpdates(initial, [["grid_cursor_goto", [1, 0, 0]]]);
    rerender(<RawGridView text="unchanged" grid={moved} />);
    expect(container.querySelector("[data-nvim-cursor]")?.textContent).toBe("日");
    expect(screen.getByTestId("nvim-screen").textContent).toBe("日a  ");
  });

  it("forwards native keys and one composition commit while suppressing browser insertion", () => {
    const send = vi.fn();
    render(<RawGridView text="plugin screen" onVimKeys={send} />);
    const view = screen.getByRole("textbox", { name: "Neovim 画面" });
    expect(fireEvent.keyDown(view, { key: "g", cancelable: true })).toBe(false);
    fireEvent.keyDown(view, { key: "Escape" });
    fireEvent.keyDown(view, { key: "Process", keyCode: 229, isComposing: true });
    fireEvent.compositionEnd(view, { data: "日本語<😀" });
    expect(send.mock.calls.map(([keys]) => keys)).toEqual(["g", "<Esc>", "日本語<lt>😀"]);
    expect(view.textContent).toBe("plugin screen");
  });
});
