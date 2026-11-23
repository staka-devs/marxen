// Raw YAML frontmatter reads as metadata, not body text, in every editor mode.

import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { Range } from "@codemirror/state";
import { parseFrontmatter } from "../../domain/frontmatter";

const LINE = Decoration.line({ class: "marxen-live-frontmatter-line" });
const KEY = Decoration.mark({ class: "marxen-live-frontmatter-key" });

/** Tint the leading `---` block's lines and color its keys. */
function frontmatterDecorations(text: string): DecorationSet {
  const front = parseFrontmatter(text);
  if (!front) return Decoration.none;
  const decorations: Range<Decoration>[] = [];
  let offset = 0;
  for (const line of text.slice(0, front.end).replace(/\r?\n$/, "").split("\n")) {
    decorations.push(LINE.range(offset));
    const key = /^([^\s#:-][^:]*):/.exec(line);
    if (key) decorations.push(KEY.range(offset, offset + key[1].length));
    offset += line.length + 1;
  }
  return Decoration.set(decorations);
}

/** Editor extension recomputing the frontmatter tint whenever the document changes. */
export const frontmatterLines = EditorView.decorations.compute(["doc"], (state) => frontmatterDecorations(state.doc.toString()));
