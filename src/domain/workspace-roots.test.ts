import { describe, expect, it } from "vitest";
import { imageTabId, parseImageTabId, rootFileLabel, rootRelativePath, searchGroupKey } from "./workspace-roots";

describe("workspace roots", () => {
  it("keys image tabs by root and path", () => {
    expect(imageTabId("root-abc", "a/b.png")).toBe("image:root-abc:a/b.png");
    expect(parseImageTabId("image:root-abc:a/b.png")).toEqual({ rootId: "root-abc", path: "a/b.png" });
    expect(parseImageTabId("image:legacy.png")).toEqual({ rootId: null, path: "legacy.png" });
    expect(parseImageTabId("doc-1")).toBeNull();
  });

  it("separates search groups by root incarnation", () => {
    const a = { rootId: "root-a", generation: "1" };
    const b = { rootId: "root-b", generation: "1" };
    expect(searchGroupKey(a, "same.md")).not.toBe(searchGroupKey(b, "same.md"));
    expect(searchGroupKey(a, "same.md")).not.toBe(searchGroupKey({ rootId: "root-a", generation: "2" }, "same.md"));
    expect(searchGroupKey(undefined, "same.md")).toBe("path:same.md");
  });

  it("labels files with their root folder", () => {
    expect(rootFileLabel("/tmp/alpha", "same.md")).toBe("alpha/same.md");
  });

});

describe("rootRelativePath", () => {
  it("finds the containing root with either separator and rejects siblings and the root itself", () => {
    const roots = [{ root: "C:\\work\\notes\\" }, { root: "/home/me/docs" }];
    expect(rootRelativePath(roots, "C:/work/notes/sub/a.md")).toEqual({ owner: roots[0], relative: "sub/a.md" });
    expect(rootRelativePath(roots, "/home/me/docs/b.md")?.relative).toBe("b.md");
    expect(rootRelativePath(roots, "C:/work/notes-old/a.md")).toBeNull();
    expect(rootRelativePath(roots, "/home/me/docs")).toBeNull();
  });
});
