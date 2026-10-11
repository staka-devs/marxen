import { act, fireEvent, render, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { expect, it, vi } from "vitest";
import { CodeMirrorEditor } from "./CodeMirrorEditor";

/** Read the actual CodeMirror instance rendered by the test fixture. */
function editorView(): EditorView {
  const dom = screen.getByTestId("editor").querySelector(".cm-editor") as HTMLElement;
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error("Editor did not mount");
  return view;
}

it("keeps heading hierarchy and exact source positions when the caret reveals Markdown", () => {
  const text = "# 日本語😀\n\n本文\n\n## 次の見出し\n";
  const onGuiEdits = vi.fn();
  render(<CodeMirrorEditor value={text} ariaLabel="検証" livePreview onGuiEdits={onGuiEdits} initialSelection={{ anchor: 0, head: 0 }} />);
  const view = editorView();
  expect(view.contentDOM.querySelector('[data-heading-level="1"]')).toHaveTextContent("# 日本語😀");
  const at = text.indexOf("##");
  act(() => view.dispatch({ selection: { anchor: at + 3 } }));
  expect(view.contentDOM.querySelector('[data-heading-level="2"]')).toHaveTextContent("## 次の見出し");
  expect(view.state.doc.toString()).toBe(text);
  expect(view.state.selection.main.head).toBe(at + 3);
  expect(onGuiEdits).not.toHaveBeenCalled();
});

it("preserves blank-line editing and treats heading-shaped code as code", () => {
  const text = "# 見出し\n\n```md\n# コード\n\n```\n";
  render(<CodeMirrorEditor value={text} ariaLabel="検証" livePreview initialSelection={{ anchor: 7, head: 7 }} />);
  const view = editorView();
  const code = text.indexOf("# コード");
  act(() => view.dispatch({ selection: { anchor: code + 1 } }));
  expect(view.contentDOM.querySelector('.marxen-live-heading')).toBeNull();
  expect(view.contentDOM.querySelectorAll('.marxen-live-code-line').length).toBe(4);
  const blank = text.indexOf("\n") + 1;
  act(() => view.dispatch({ selection: { anchor: blank } }));
  const lines = [...view.contentDOM.querySelectorAll('.cm-line')];
  const active = lines.find((line) => view.posAtDOM(line) === blank);
  expect(active).toBeDefined();
  expect(active).not.toHaveClass("marxen-live-gap");
  expect(view.state.doc.toString()).toBe(text);
  expect(view.state.selection.main.head).toBe(blank);
});

it("captures GUI source and cursor in one committed edit", () => {
  const events: string[] = [];
  /** Capture the committed source change and its final cursor together. */
  const onGuiEdits = vi.fn(() => events.push("edit"));
  render(<CodeMirrorEditor value="前後" ariaLabel="検証" onGuiEdits={onGuiEdits} onSelectionChange={() => events.push("selection")} />);
  const view = editorView();
  act(() => view.dispatch({ changes: { from: 1, insert: "😀" }, selection: { anchor: 3 } }));
  expect(events).toEqual(["edit"]);
  expect(onGuiEdits).toHaveBeenCalledWith([{ range: { start: 1, end: 1 }, text: "😀" }], "前後", { anchor: 3, head: 3 }, undefined);
});

it("keeps preedit cursor positions out of Neovim and commits composition with its final cursor", () => {
  const events: string[] = [];
  /** Record selection-only reports separately from the committed edit. */
  const onSelectionChange = vi.fn(() => events.push("selection"));
  /** Capture the committed source change and its final cursor together. */
  const onGuiEdits = vi.fn(() => events.push("edit"));
  render(<CodeMirrorEditor value="前後" ariaLabel="検証" onGuiEdits={onGuiEdits} onSelectionChange={onSelectionChange} />);
  const view = editorView();
  fireEvent.compositionStart(view.contentDOM);
  act(() => view.dispatch({ changes: { from: 1, insert: "日本語😀" }, selection: { anchor: 6 } }));
  expect(events).toEqual([]);
  fireEvent.compositionEnd(view.contentDOM);
  expect(events).toEqual(["edit"]);
  expect(onSelectionChange).not.toHaveBeenCalled();
  expect(onGuiEdits).toHaveBeenCalledWith([{ range: { start: 1, end: 1 }, text: "日本語😀" }], "前後", { anchor: 6, head: 6 });
});

it("retains native cursor ownership through an IME composition across an ACK", () => {
  let pending = true;
  const onGuiEdits = vi.fn();
  const { rerender } = render(<CodeMirrorEditor value="前後" ariaLabel="検証" shouldUseNativeCursor={() => pending} onGuiEdits={onGuiEdits} />);
  const view = editorView();
  fireEvent.compositionStart(view.contentDOM);
  pending = false;
  rerender(<CodeMirrorEditor value="前\n後" ariaLabel="検証" shouldUseNativeCursor={() => pending} onGuiEdits={onGuiEdits} />);
  act(() => view.dispatch({ changes: { from: 1, insert: "日本語" }, selection: { anchor: 4 } }));
  expect(onGuiEdits).not.toHaveBeenCalled();
  fireEvent.compositionEnd(view.contentDOM);
  expect(onGuiEdits).toHaveBeenCalledWith([{ range: { start: 1, end: 1 }, text: "日本語" }], "前後", { anchor: 4, head: 4 }, undefined, true);
});

it("restores a rejected local edit when canonical text and revision are unchanged", () => {
  const before = { documentId: "doc", revision: 0, text: "a😀b", dirty: false };
  const { rerender } = render(<CodeMirrorEditor value={before.text} snapshot={before} ariaLabel="検証" />);
  const view = editorView();
  act(() => view.dispatch({ changes: { from: 1, insert: "X" }, selection: { anchor: 2 } }));
  expect(view.state.doc.toString()).toBe("aX😀b");
  rerender(<CodeMirrorEditor value={before.text} snapshot={{ ...before }} ariaLabel="検証" />);
  expect(view.state.doc.toString()).toBe(before.text);
});

it("applies a canonical text update before its new cursor in the same render", () => {
  const { rerender } = render(<CodeMirrorEditor value="" ariaLabel="検証" externalCursor={{ seq: 1, anchor: 0, head: 0 }} />);
  const view = editorView();
  rerender(<CodeMirrorEditor value="abc" ariaLabel="検証" externalCursor={{ seq: 2, anchor: 3, head: 3 }} />);
  expect(view.state.doc.toString()).toBe("abc");
  expect(view.state.selection.main.head).toBe(3);
});

it("rejects composition if native mode stops permitting input before commit", () => {
  const onGuiEdits = vi.fn();
  const { rerender } = render(<CodeMirrorEditor value="前後" ariaLabel="検証" allowTextInput onGuiEdits={onGuiEdits} />);
  const view = editorView();
  fireEvent.compositionStart(view.contentDOM);
  act(() => view.dispatch({ changes: { from: 1, insert: "日本語" }, selection: { anchor: 4 } }));
  rerender(<CodeMirrorEditor value="前後" ariaLabel="検証" allowTextInput={false} onGuiEdits={onGuiEdits} />);
  fireEvent.compositionEnd(view.contentDOM);
  expect(onGuiEdits).not.toHaveBeenCalled();
  expect(view.state.doc.toString()).toBe("前後");
});
