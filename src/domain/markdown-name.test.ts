import { expect, it } from "vitest";
import { markdownPath } from "./markdown-name";

it("appends .md unless the name is already Markdown", () => {
  expect(markdownPath("メモ/新規")).toBe("メモ/新規.md");
  expect(markdownPath("notes/a.MD")).toBe("notes/a.MD");
  expect(markdownPath("readme.markdown")).toBe("readme.markdown");
  expect(markdownPath("draft.txt")).toBe("draft.txt.md");
  expect(markdownPath(".env")).toBe(".env.md");
});
