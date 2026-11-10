import { describe, expect, it } from "vitest";
import { maskFrontmatter, parseFrontmatter, setPropertyEdit } from "./frontmatter";

const note = "---\nstatus: todo\ntitle: \"A: B\"\ntags:\n  - x\n---\n# Body\n";

describe("frontmatter", () => {
  it("reads flat properties and marks nested ones read-only", () => {
    const front = parseFrontmatter(note)!;
    expect(front.end).toBe(note.indexOf("# Body"));
    expect(front.properties.map(({ key, value, editable }) => [key, value, editable])).toEqual([
      ["status", "todo", true],
      ["title", "A: B", true],
      ["tags", "- x", false],
    ]);
    expect(parseFrontmatter("# no\n---\n")).toBeNull();
    expect(parseFrontmatter("---\nunclosed: 1\n")).toBeNull();
  });

  it("masks the block with same-length blanks", () => {
    const masked = maskFrontmatter(note);
    expect(masked.length).toBe(note.length);
    expect(masked.split("\n").length).toBe(note.split("\n").length);
    expect(masked.trimStart().startsWith("# Body")).toBe(true);
  });

  it("builds value edits with quoting and offsets", () => {
    expect(setPropertyEdit(note, "status", "done", 10)).toEqual({ range: { start: 22, end: 26 }, text: "done" });
    expect(setPropertyEdit(note, "title", "x: y")?.text).toBe("\"x: y\"");
    expect(setPropertyEdit(note, "tags", "y")).toBeNull();
    expect(setPropertyEdit(note, "missing", "y")).toBeNull();
  });
});
