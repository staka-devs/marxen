import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { GuiToolbar } from "./GuiToolbar";
import { tableCellAt } from "../../domain/markdown-gui";

afterEach(cleanup);
/** Build the used toolbar callbacks for interaction assertions. */
function toolbarProps() {
  return { onFormat: vi.fn(), onCheckbox: vi.fn(), onTable: vi.fn(), onTableAction: vi.fn(), tableCell: null, onLink: vi.fn(), onImage: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn(), hardBreakOnEnter: false, onHardBreakOnEnter: vi.fn() };
}

it("exposes formatting and the controlled saved Enter toggle without an overflow menu", () => {
  const props = toolbarProps();
  const view = render(<GuiToolbar {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "太字にする" }));
  expect(props.onFormat).toHaveBeenCalledWith("bold");
  fireEvent.click(screen.getByRole("button", { name: "EnterでMarkdown改行" }));
  expect(props.onHardBreakOnEnter).toHaveBeenCalledWith(true);
  view.rerender(<GuiToolbar {...props} hardBreakOnEnter />);
  expect(screen.getByRole("button", { name: "EnterでMarkdown改行" })).toHaveAttribute("aria-pressed", "true");
});

it("uses sensible table dimensions and submits explicitly chosen values", () => {
  const props = toolbarProps();
  render(<GuiToolbar {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "表を挿入する" }));
  expect(screen.getByRole("spinbutton", { name: "本文行数" })).toHaveValue(2);
  expect(screen.getByRole("spinbutton", { name: "列数" })).toHaveValue(3);
  fireEvent.change(screen.getByRole("spinbutton", { name: "本文行数" }), { target: { value: "4" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: "列数" }), { target: { value: "2" } });
  fireEvent.click(within(screen.getByRole("form", { name: "表のサイズ" })).getByRole("button", { name: "表を挿入する" }));
  expect(props.onTable).toHaveBeenCalledWith(4, 2);
});

it("shows selected-cell structural actions and column alignment while protecting the header", () => {
  const props = toolbarProps();
  const text = "| A | B |\n| --- | ---: |\n| a | b |";
  const view = render(<GuiToolbar {...props} tableCell={tableCellAt(text, text.lastIndexOf("b"))} />);
  fireEvent.click(screen.getByRole("button", { name: "左に列を追加" }));
  expect(props.onTableAction).toHaveBeenCalledWith("column-left");
  fireEvent.click(screen.getByRole("button", { name: "上に行を追加" }));
  expect(props.onTableAction).toHaveBeenCalledWith("row-above");
  fireEvent.change(screen.getByRole("combobox", { name: "列の配置" }), { target: { value: "center" } });
  expect(props.onTableAction).toHaveBeenCalledWith("align-center");
  view.rerender(<GuiToolbar {...props} tableCell={tableCellAt(text, 0)} />);
  expect(screen.getByRole("button", { name: "行を削除" })).toBeDisabled();
});
