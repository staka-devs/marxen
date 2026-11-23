import { describe, expect, it } from "vitest";
import type { TextEdit } from "../contracts/contracts";
import { computeLiveBlocks } from "./render/blocks";
import { BLOCK_TEMPLATES, databaseFlagEdit, deleteBlockEdit, duplicateBlockEdit, filterTemplates, moveBlockEdit } from "./block-edits";

/** Apply one edit to a string. */
function apply(text: string, edit: TextEdit | null): string {
  if (!edit) return text;
  return text.slice(0, edit.range.start) + edit.text + text.slice(edit.range.end);
}

const doc = "# A\n\npara B\n\n- c\n- d\n\n\nlast E";

describe("block edits", () => {
  const blocks = computeLiveBlocks(doc);

  it("moves a block while separators stay in place", () => {
    expect(blocks.length).toBe(4);
    expect(apply(doc, moveBlockEdit(doc, blocks, 0, 2))).toBe("para B\n\n# A\n\n- c\n- d\n\n\nlast E");
    expect(apply(doc, moveBlockEdit(doc, blocks, 3, 0))).toBe("last E\n\n# A\n\npara B\n\n\n- c\n- d");
    expect(apply(doc, moveBlockEdit(doc, blocks, 1, 4))).toBe("# A\n\n- c\n- d\n\nlast E\n\n\npara B");
    expect(moveBlockEdit(doc, blocks, 1, 1)).toBeNull();
    expect(moveBlockEdit(doc, blocks, 1, 2)).toBeNull();
    expect(moveBlockEdit(doc, blocks, 5, 0)).toBeNull();
  });

  it("duplicates and deletes blocks", () => {
    expect(apply(doc, duplicateBlockEdit(doc, blocks[0]))).toBe("# A\n\n# A\n\npara B\n\n- c\n- d\n\n\nlast E");
    expect(apply(doc, deleteBlockEdit(blocks, 1))).toBe("# A\n\n- c\n- d\n\n\nlast E");
    expect(apply(doc, deleteBlockEdit(blocks, 3))).toBe("# A\n\npara B\n\n- c\n- d");
    expect(apply("only", deleteBlockEdit(computeLiveBlocks("only"), 0))).toBe("");
  });

  it("offers templates with the caret inside and filters them", () => {
    const toggle = BLOCK_TEMPLATES.find((item) => item.id === "toggle")!;
    expect(toggle.text.slice(toggle.caret, toggle.caret + 10)).toBe("</summary>");
    expect(filterTemplates("見出し", (key) => key).map((item) => item.id)).toEqual(["h1", "h2", "h3"]);
    expect(filterTemplates("kanban", (key) => key).map((item) => item.id)).toEqual(["board"]);
    expect(filterTemplates("", (key) => key).length).toBe(BLOCK_TEMPLATES.length);
  });

  it("turns database views on through the frontmatter", () => {
    expect(apply("# x", databaseFlagEdit("# x"))).toBe("---\ndatabase: true\n---\n# x");
    expect(apply("---\ntitle: a\n---\nbody", databaseFlagEdit("---\ntitle: a\n---\nbody"))).toBe("---\ntitle: a\ndatabase: true\n---\nbody");
    expect(apply("---\ndatabase: false\n---\n", databaseFlagEdit("---\ndatabase: false\n---\n"))).toBe("---\ndatabase: true\n---\n");
    expect(databaseFlagEdit("---\ndatabase: true\n---\n")).toBeNull();
  });
});
