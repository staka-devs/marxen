import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root as MdastRoot } from "mdast";
import { alertKind, mdastText } from "./mdast";

function firstBlock(source: string) {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source) as MdastRoot;
  return tree.children[0];
}

describe("shared mdast helpers", () => {
  it("extracts heading text across inline children", () => {
    const node = firstBlock("# 東京 😀 **太字**\n");
    expect(mdastText(node as never)).toContain("東京 😀");
  });

  it("detects GitHub alert kinds case-insensitively", () => {
    const note = firstBlock("> [!NOTE]\n> 本文\n");
    expect(alertKind(note as never)).toBe("note");
    const plain = firstBlock("> ただの引用\n");
    expect(alertKind(plain as never)).toBeNull();
    const paragraph = firstBlock("本文\n");
    expect(alertKind(paragraph as never)).toBeNull();
  });
});
