import { describe, expect, it } from "vitest";
import { imageTabId, parseImageTabId, rootFileLabel, searchGroupKey } from "./workspace-roots";

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
