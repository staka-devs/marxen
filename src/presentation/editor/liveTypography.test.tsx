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

it("reports committed GUI text before its new cursor position", () => {
  const events: string[] = [];
  render(<CodeMirrorEditor value="前後" ariaLabel="検証" onGuiEdits={() => events.push("edit")} onSelectionChange={() => events.push("selection")} />);
  const view = editorView();
  act(() => view.dispatch({ changes: { from: 1, insert: "😀" }, selection: { anchor: 3 } }));
  expect(events).toEqual(["edit", "selection"]);
});

it("keeps preedit cursor positions out of Neovim and reports the committed position last", () => {
  const events: string[] = [];
  /** Record committed cursor reports after the document edit callback. */
  const onSelectionChange = vi.fn(() => events.push("selection"));
  render(<CodeMirrorEditor value="前後" ariaLabel="検証" onGuiEdits={() => events.push("edit")} onSelectionChange={onSelectionChange} />);
  const view = editorView();
  fireEvent.compositionStart(view.contentDOM);
  act(() => view.dispatch({ changes: { from: 1, insert: "日本語😀" }, selection: { anchor: 6 } }));
  expect(events).toEqual([]);
  fireEvent.compositionEnd(view.contentDOM);
  expect(events).toEqual(["edit", "selection"]);
  expect(onSelectionChange).toHaveBeenLastCalledWith({ anchor: 6, head: 6 });
});
