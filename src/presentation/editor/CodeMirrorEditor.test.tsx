import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { CodeMirrorEditor, singleEditFromDiff } from "./CodeMirrorEditor";
import { applyTextEdits } from "../../domain/coordinates/utf16";

afterEach(cleanup);

describe("native snapshot newline coordinates", () => {
  it.each(["日😀\r\n本文\r\n", "# Alpha 検証\n\n日本語の検索対象です。\r\n", "日\r本文\n"])("preserves every native UTF-16 unit in %j", (source) => {
    const edits = vi.fn();
    const selection = vi.fn();
    const rendered = render(<CodeMirrorEditor value={source} ariaLabel="editor" onGuiEdits={edits} onSelectionChange={selection} initialSelection={{ anchor: source.length, head: source.length }} />);
    const view = EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-content")!)!;
    expect(view.state.doc.toString()).toBe(source);
    expect(view.state.selection.main.head).toBe(source.length);
    act(() => view.dispatch({ selection: { anchor: source.indexOf("\n") + 1 } }));
    expect(selection).toHaveBeenLastCalledWith({ anchor: source.indexOf("\n") + 1, head: source.indexOf("\n") + 1 });
    act(() => view.dispatch({ changes: { from: source.length, insert: "追😀" }, selection: { anchor: source.length + 3 } }));
    expect(edits).toHaveBeenLastCalledWith([{ range: { start: source.length, end: source.length }, text: "追😀" }], source, { anchor: source.length + 3, head: source.length + 3 }, undefined);
    const acknowledged = source + "追😀";
    rendered.rerender(<CodeMirrorEditor value={acknowledged} ariaLabel="editor" />);
    expect(view.state.doc.toString()).toBe(acknowledged);
    rendered.rerender(<CodeMirrorEditor value={source} ariaLabel="editor" externalCursor={{ anchor: source.length, head: source.length, seq: 1 }} />);
    expect(view.state.doc.toString()).toBe(source);
    expect(view.state.selection.main.head).toBe(source.length);
  });

  it("reports an Alt+drag rectangle as block corners for blockwise Visual", () => {
    const selection = vi.fn();
    const rendered = render(<CodeMirrorEditor value={"abcd\nefgh\nijkl"} ariaLabel="editor" onSelectionChange={selection} />);
    const view = EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-content")!)!;
    act(() => view.dispatch({ selection: EditorSelection.create([EditorSelection.range(1, 3), EditorSelection.range(6, 8), EditorSelection.range(11, 13)]) }));
    expect(selection).toHaveBeenLastCalledWith({ anchor: 1, head: 13, block: true });
  });

  it("resynchronizes a rejected first character at a mixed-newline document end without unmounting", () => {
    const source = "# Alpha 検証\n\n日本語の検索対象です。\r\n";
    const snapshot = { documentId: "native", revision: 0, text: source, dirty: false };
    const rendered = render(<CodeMirrorEditor value={source} snapshot={snapshot} ariaLabel="editor" />);
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(content)!;
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "q" }, selection: { anchor: view.state.doc.length + 1 } }));
    rendered.rerender(<CodeMirrorEditor value={source} snapshot={{ ...snapshot }} ariaLabel="editor" />);
    expect(rendered.getByRole("textbox", { name: "editor" })).toBe(content);
    expect(view.state.doc.toString()).toBe(source);
    expect(view.state.selection.main.head).toBe(source.length);
  });
});

it("handles right click and keyboard menu gestures only in an explicitly wired editor", () => {
  const menu = vi.fn();
  const view = render(<CodeMirrorEditor value="abc" ariaLabel="editor" onEditorMenu={menu} />);
  const content = view.container.querySelector<HTMLElement>(".cm-content")!;
  const rightClick = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  content.dispatchEvent(rightClick);
  expect(rightClick.defaultPrevented).toBe(true);
  expect(menu).toHaveBeenCalledOnce();
  fireEvent.keyDown(content, { key: "ContextMenu" });
  fireEvent.keyDown(content, { key: "F10", shiftKey: true });
  expect(menu).toHaveBeenCalledTimes(3);
  menu.mock.calls[2][0].restoreFocus();
  expect(content).toHaveFocus();
  view.rerender(<CodeMirrorEditor value="abc" ariaLabel="editor" />);
  const native = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  content.dispatchEvent(native);
  expect(native.defaultPrevented).toBe(false);
});

it("keeps menu gestures from consuming or replacing IME preedit", () => {
  const menu = vi.fn();
  const edits = vi.fn();
  const view = render(<CodeMirrorEditor value="日本😀" ariaLabel="editor" onEditorMenu={menu} onGuiEdits={edits} />);
  const content = view.container.querySelector<HTMLElement>(".cm-content")!;
  fireEvent.compositionStart(content);
  fireEvent.contextMenu(content);
  fireEvent.keyDown(content, { key: "F10", shiftKey: true, isComposing: true });
  fireEvent.keyDown(content, { key: "Enter", isComposing: true, keyCode: 229 });
  expect(menu).not.toHaveBeenCalled();
  expect(edits).not.toHaveBeenCalled();
  fireEvent.compositionEnd(content);
});

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


it("highlights lines changed by the latest AI change against its baseline", () => {
  const rendered = render(<CodeMirrorEditor value={"# T\nnew line\nend"} ariaLabel="editor" aiBaseline={"# T\nold line\nend"} />);
  expect(rendered.container.querySelector(".marxen-ai-added")).toHaveTextContent("new line");
  expect(rendered.container.querySelector(".marxen-ai-removed")).toHaveTextContent("old line");
  rendered.rerender(<CodeMirrorEditor value={"# T\nnew line\nend"} ariaLabel="editor" aiBaseline={null} />);
  expect(rendered.container.querySelector(".marxen-ai-added")).toBeNull();
});
