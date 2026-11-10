import { describe, expect, it } from "vitest";
import { bundleOf, isBundleFolder } from "./bundle";
import { databasesEnabled } from "./frontmatter";

describe("bundles", () => {
  it("recognizes bundle folders and their index notes", () => {
    expect(isBundleFolder("notes/メモ.marxen")).toBe(true);
    expect(isBundleFolder(".marxen")).toBe(false);
    expect(bundleOf("notes/メモ.marxen/index.md")).toBe("notes/メモ.marxen");
    expect(bundleOf("notes/メモ.marxen")).toBe("notes/メモ.marxen");
    expect(bundleOf("notes/メモ.marxen/other.md")).toBeNull();
    expect(bundleOf("notes/index.md")).toBeNull();
  });

  it("enables databases per note from frontmatter", () => {
    expect(databasesEnabled("---\ndatabase: true\n---\n")).toBe(true);
    expect(databasesEnabled("---\ndatabase: false\n---\n")).toBe(false);
    expect(databasesEnabled("database: true\n")).toBe(false);
  });
});
