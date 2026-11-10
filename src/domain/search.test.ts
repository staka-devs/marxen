import { describe, expect, it } from "vitest";
import { parseSearchCommand, parseSubstituteCommand, vimSearchPattern } from "./search";

describe("parseSubstituteCommand", () => {
  it.each([
    [":s/test/a", { pattern: "test", replacement: "a" }],
    [":%s/test/a/g", { pattern: "test", replacement: "a" }],
    [":'<,'>substitute#a\\#b#c#", { pattern: "a#b", replacement: "c" }],
    [":1,$s/x\\/y/\\1/gc", { pattern: "x/y", replacement: "\\1" }],
    [":s/\\(te\\)st", { pattern: "\\(te\\)st", replacement: "" }],
    [":s/日本/語", { pattern: "日本", replacement: "語" }],
  ])("reads %j", (text, expected) => {
    expect(parseSubstituteCommand(text)).toEqual(expected);
  });

  it.each([":set nu", ":sort /x/", ":s//a", "/test", ":", ":w"])("ignores %j", (text) => {
    expect(parseSubstituteCommand(text)).toBeNull();
  });
});

describe("Vim search bridge", () => {
  it("reads typed / and ? patterns only", () => {
    expect(parseSearchCommand("/foo")).toBe("foo");
    expect(parseSearchCommand("?a b")).toBe("a b");
    expect(parseSearchCommand("/")).toBeNull();
    expect(parseSearchCommand(":s/a/b")).toBeNull();
  });

  it("turns find bar queries into Vim patterns", () => {
    expect(vimSearchPattern("テスト", { caseSensitive: true, wholeWord: false, regex: true })).toBe("テスト");
    const literal = { caseSensitive: false, wholeWord: false, regex: false };
    expect(vimSearchPattern("a.b\\c", literal)).toBe(String.raw`\ca\.b\\c`);
    expect(vimSearchPattern("テスト/1", literal)).toBe(String.raw`テスト\/1`);
    expect(vimSearchPattern("foo", { ...literal, caseSensitive: true, wholeWord: true })).toBe(String.raw`\C\<foo\>`);
    expect(vimSearchPattern("a|b", { ...literal, regex: true, wholeWord: true })).toBe(String.raw`\c\v<(a|b)>`);
  });
});
