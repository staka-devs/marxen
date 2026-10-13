import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EditorMenu } from "./EditorMenu";
import type { EditorContext } from "../../contracts/contracts";

afterEach(cleanup);
const context: EditorContext = { cursor: { documentId: "doc", revision: 4, anchor: 1, head: 4 }, mode: "visual", presentation: { editable: true, selectionToolbar: true, mappings: [{ lhs: "Q", rhs: ":echo 'actual'<CR>" }] } };
/** Supply one captured native editor-menu gesture and its operation spies. */
function menuProps() { return { point: { x: 5, y: 10, keyboard: true, restoreFocus: vi.fn() }, context, popup: false, markdown: true, disabled: false, onAction: vi.fn(), onFormat: vi.fn(), onDismiss: vi.fn() }; }

it("runs explicit native actions and displays actual mappings without browser shortcuts", () => {
  const props = menuProps();
  render(<EditorMenu {...props} />);
  const first = screen.getByRole("menuitem", { name: "元に戻す" });
  expect(first).toHaveFocus();
  fireEvent.keyDown(first, { key: "ArrowDown" });
  expect(screen.getByRole("menuitem", { name: "やり直す" })).toHaveFocus();
  fireEvent.click(screen.getByRole("menuitem", { name: "選択範囲を切り取る" }));
  expect(props.onAction).toHaveBeenCalledWith("cut");
  fireEvent.click(screen.getByText(/現在のVimマッピング/));
  expect(screen.getByText("Q")).toBeVisible();
  expect(screen.getByText(/actual/)).toBeVisible();
  expect(screen.queryByText(/Ctrl\+/)).toBeNull();
  fireEvent.keyDown(first, { key: "Escape" });
  expect(props.onDismiss).toHaveBeenCalledOnce();
});

it("keeps the opted-in selection popup from taking focus or handling Vim keys", () => {
  const props = menuProps();
  const editor = document.createElement("input");
  document.body.append(editor);
  editor.focus();
  render(<EditorMenu {...props} popup />);
  expect(editor).toHaveFocus();
  fireEvent.keyDown(screen.getByRole("toolbar"), { key: "Escape" });
  expect(props.onDismiss).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "太字" }));
  expect(props.onFormat).toHaveBeenCalledWith("bold");
  editor.remove();
});

it("disables mutations on read-only editors and copy/cut for collapsed native selections", () => {
  const props = menuProps();
  const view = render(<EditorMenu {...props} disabled />);
  expect(screen.getByRole("menuitem", { name: "クリップボードから貼り付け" })).toBeDisabled();
  view.rerender(<EditorMenu {...props} context={{ ...context, cursor: { ...context.cursor, head: 1 } }} />);
  expect(screen.getByRole("menuitem", { name: "選択範囲をコピー" })).toBeDisabled();
});
