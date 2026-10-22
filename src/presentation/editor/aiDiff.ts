import { StateField, type Extension, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { lineChanges } from "../../domain/line-diff";

/** Struck-through original lines shown where an AI change removed them. */
class RemovedLines extends WidgetType {
  /** Keep the removed original lines for display. */
  constructor(readonly lines: string[]) { super(); }

  /** Reuse the DOM while the same lines are removed. */
  eq(other: RemovedLines): boolean { return other.lines.join("\n") === this.lines.join("\n"); }

  /** Render each removed line as read-only struck-through text. */
  toDOM(): HTMLElement {
    const block = document.createElement("div");
    block.className = "marxen-ai-removed";
    block.setAttribute("aria-hidden", "true");
    for (const line of this.lines) {
      const row = document.createElement("div");
      row.textContent = line || " ";
      block.append(row);
    }
    return block;
  }

  /** The widget is display-only; clicks go to the surrounding text. */
  ignoreEvent(): boolean { return true; }
}

/** Decorate added lines and insert removed ones relative to the original text. */
function build(state: EditorState, before: string): DecorationSet {
  const doc = state.doc;
  const ranges = [];
  for (const change of lineChanges(before, doc.toString())) {
    const atEnd = change.line >= doc.lines;
    const position = atEnd ? doc.length : doc.line(change.line + 1).from;
    if (change.removed.length > 0) {
      ranges.push(Decoration.widget({ widget: new RemovedLines(change.removed), block: true, side: atEnd ? 1 : -1 }).range(position));
    }
    for (let offset = 0; offset < change.added && change.line + offset < doc.lines; offset += 1) {
      ranges.push(Decoration.line({ class: "marxen-ai-added" }).range(doc.line(change.line + offset + 1).from));
    }
  }
  return Decoration.set(ranges, true);
}

/** Inline diff of the current text against the text before an AI change; empty without a baseline. */
export function aiDiff(before: string | null): Extension {
  if (before === null) return [];
  return StateField.define<DecorationSet>({
    /** Diff the initial document. */
    create: (state) => build(state, before),
    /** Re-diff only when the text changes. */
    update: (value, transaction) => (transaction.docChanged ? build(transaction.state, before) : value),
    /** Expose the decorations to the editor view. */
    provide: (field) => EditorView.decorations.from(field),
  });
}
