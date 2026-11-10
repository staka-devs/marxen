import { describe, expect, it } from "vitest";
import { inlineMarks } from "./inline-marks";

/** Show each mark as its kind, whole text and content text. */
function shown(text: string) {
  return inlineMarks(text).map((mark) => [mark.kind, text.slice(mark.from, mark.to), text.slice(mark.contentFrom, mark.contentTo)]);
}

describe("inlineMarks", () => {
  it("finds emphasis, code, strikethrough and links with their content", () => {
    expect(shown("a **太字** b *斜体* `x` ~~消~~ [文](https://e.com)")).toEqual([
      ["strong", "**太字**", "太字"],
      ["emphasis", "*斜体*", "斜体"],
      ["code", "`x`", "x"],
      ["delete", "~~消~~", "消"],
      ["link", "[文](https://e.com)", "文"],
    ]);
  });

  it("keeps nested spans and double-backtick code", () => {
    expect(shown("**a *b***")).toEqual([["strong", "**a *b***", "a *b*"], ["emphasis", "*b*", "b"]]);
    expect(shown("``a`b``")).toEqual([["code", "``a`b``", "a`b"]]);
  });

  it("styles bare URLs without markers and ignores fenced code", () => {
    expect(shown("see https://e.com")).toEqual([["link", "https://e.com", "https://e.com"]]);
    expect(shown("```\n**no**\n```")).toEqual([]);
  });
});
