import type { Extension } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";

const MATCH = Decoration.mark({ class: "marxen-search-match" });

/** Highlight find-bar and Vim search matches (like `hlsearch`), dropping ranges a newer edit pushed past the end. */
export function searchMatches(ranges: ReadonlyArray<{ from: number; to: number }>): Extension {
  if (ranges.length === 0) return [];
  return EditorView.decorations.compute(["doc"], (state) =>
    Decoration.set(ranges.filter((range) => range.to > range.from && range.to <= state.doc.length).map((range) => MATCH.range(range.from, range.to)), true));
}
