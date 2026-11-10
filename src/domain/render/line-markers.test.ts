import { describe, expect, it } from "vitest";
import { lineMarkers } from "./line-markers";

/** Show each marker as its kind and replaced text. */
function shown(text: string) {
  return lineMarkers(text).map((marker) => [marker.kind, text.slice(marker.markerFrom, marker.markerTo), marker.checked ?? marker.label ?? null]);
}

describe("lineMarkers", () => {
  it("finds bullets, ordered items and tasks with indentation kept", () => {
    expect(shown("- a\n  * b\n3. c\n- [x] d\n- [ ] e")).toEqual([
      ["bullet", "- ", null],
      ["bullet", "* ", null],
      ["ordered", "3. ", "3."],
      ["task", "- [x] ", true],
      ["task", "- [ ] ", false],
    ]);
  });

  it("separates quote markers from a list inside the quote", () => {
    expect(shown("> a\n> > b\n> - c")).toEqual([
      ["quote", "> ", null],
      ["quote", "> > ", null],
      ["quote", "> ", null],
      ["bullet", "- ", null],
    ]);
  });

  it("ignores lines without a marker and dashes without a space", () => {
    expect(shown("text\n-not\n---")).toEqual([]);
  });
});
