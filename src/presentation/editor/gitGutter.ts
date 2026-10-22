import { RangeSetBuilder, StateField, type EditorState, type Extension, type RangeSet } from "@codemirror/state";
import { GutterMarker, gutter } from "@codemirror/view";
import { lineChanges } from "../../domain/line-diff";

/** One change-gutter mark: lines added, changed from HEAD, or removed just above. */
class ChangeMarker extends GutterMarker {
  /** Keep the change kind for the marker class. */
  constructor(readonly kind: "added" | "modified" | "deleted") { super(); }

  /** Reuse markers of the same kind. */
  eq(other: ChangeMarker): boolean { return other.kind === this.kind; }

  /** Render a thin colored bar (VS Code quick diff). */
  toDOM(): HTMLElement {
    const mark = document.createElement("div");
    mark.className = `marxen-git-${this.kind}`;
    return mark;
  }
}

const MARKERS = { added: new ChangeMarker("added"), modified: new ChangeMarker("modified"), deleted: new ChangeMarker("deleted") };

/** Compare the current text with HEAD and mark each changed line once, in document order. */
function build(state: EditorState, head: string): RangeSet<GutterMarker> {
  const doc = state.doc;
  const builder = new RangeSetBuilder<GutterMarker>();
  // CRLF checkouts of LF blobs must not mark every line; only \n splits lines, so indexes stay valid.
  for (const change of lineChanges(head.replaceAll("\r", ""), doc.toString().replaceAll("\r", ""))) {
    if (change.added === 0) {
      builder.add(doc.line(Math.min(change.line + 1, doc.lines)).from, doc.line(Math.min(change.line + 1, doc.lines)).from, MARKERS.deleted);
      continue;
    }
    const kind = change.removed.length > 0 ? MARKERS.modified : MARKERS.added;
    for (let offset = 0; offset < change.added && change.line + offset < doc.lines; offset += 1) {
      const from = doc.line(change.line + offset + 1).from;
      builder.add(from, from, kind);
    }
  }
  return builder.finish();
}

/** Change gutter against the file's HEAD text; empty when the file is not committed. */
export function gitGutter(head: string | null): Extension {
  if (head === null) return [];
  const field = StateField.define<RangeSet<GutterMarker>>({
    /** Mark the initial document. */
    create: (state) => build(state, head),
    /** Re-mark only when the text changes. */
    update: (value, transaction) => (transaction.docChanged ? build(transaction.state, head) : value),
  });
  return [field, gutter({
    class: "marxen-git-gutter",
    /** Read this editor's current marks. */
    markers: (view) => view.state.field(field),
  })];
}
