import { findClusterBreak } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/** Size the Vim block caret to the actual glyph in proportional live-preview text. */
export const blockCursorWidth = ViewPlugin.fromClass(class {
  /** Schedule glyph measurement after the editor's initial layout. */
  constructor(private readonly view: EditorView) {
    this.measure();
  }

  /** Refresh cursor width when its position, font, wrapping, or viewport changes. */
  update(update: ViewUpdate): void {
    if (update.selectionSet || update.geometryChanged || update.focusChanged) this.measure();
  }

  /** Read glyph bounds in CodeMirror's layout phase and publish only the cursor width. */
  private measure(): void {
    this.view.requestMeasure({
      key: this,
      /** Measure one grapheme without crossing a visual line break. */
      read: (view) => {
        const head = view.state.selection.main.head;
        const line = view.state.doc.lineAt(head);
        const offset = head - line.from;
        if (offset === line.length) return view.defaultCharacterWidth;
        const end = line.from + findClusterBreak(line.text, offset);
        const from = view.coordsAtPos(head, 1);
        const to = view.coordsAtPos(end, -1);
        if (!from || !to || Math.abs(from.top - to.top) > 1) return view.defaultCharacterWidth;
        return Math.max(1, Math.abs(to.left - from.left));
      },
      /** Apply the measured width without changing document text or selection. */
      write: (width) => this.view.dom.style.setProperty("--marxen-cursor-width", width + "px"),
    });
  }

  /** Remove the presentation-only width when this editor is disposed. */
  destroy(): void {
    this.view.dom.style.removeProperty("--marxen-cursor-width");
  }
});
