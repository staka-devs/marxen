import { describe, expect, it } from "vitest";
import { parseSubstituteCommand } from "./search";

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
