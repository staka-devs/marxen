import { describe, expect, it, beforeEach } from "vitest";
import { loadWorkspaceMetadata, normalizeWorkspaceMetadata, saveWorkspaceMetadata } from "./workspace-metadata-store";

describe("workspace metadata store", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("falls back to empty metadata when missing", () => {
    expect(loadWorkspaceMetadata()).toEqual({ version: 1, roots: [], tabs: [], active: null });
  });

  it("round-trips roots, tabs, and active without deleting missing entries", () => {
    const metadata = {
      version: 1 as const,
      roots: [{ root: "/tmp/a" }, { root: "/tmp/missing" }],
      tabs: [{ root: "/tmp/a", path: "same.md", image: false }],
      active: { root: "/tmp/a", path: "same.md", image: false },
    };
    expect(saveWorkspaceMetadata(metadata)).toBe(true);
    expect(loadWorkspaceMetadata()).toEqual(metadata);
  });

  it("accepts legacy single-root strings and dedupes", () => {
    expect(normalizeWorkspaceMetadata("/tmp/a")).toEqual({
      version: 1,
      roots: [{ root: "/tmp/a" }],
      tabs: [],
      active: null,
    });
    expect(normalizeWorkspaceMetadata({ version: 1, roots: [{ root: "/tmp/a" }, { root: "/tmp/a" }], tabs: [], active: null }).roots).toEqual([{ root: "/tmp/a" }]);
  });
});

it("retains unsupported, malformed and structurally invalid metadata bytes", async () => {
  const { workspaceMetadataStore } = await import("./workspace-metadata-store");
  for (const raw of ["{broken", JSON.stringify({ version: 2, roots: ["/missing"] }), "[]", "42"]) {
    localStorage.setItem("marxen.workspace-metadata.v1", raw);
    expect(workspaceMetadataStore.load()).toBeNull();
    expect(localStorage.getItem("marxen.workspace-metadata.v1")).toBe(raw);
  }
});

it("round-trips UTF-16 selections without storing text and deduplicates owned tab identity", () => {
  const tab = { root: "/a", path: "same.md", image: false, selection: { anchor: 2, head: 5 } };
  saveWorkspaceMetadata({ version: 1, roots: [{ root: "/a" }], tabs: [tab, tab], active: tab });
  expect(loadWorkspaceMetadata().tabs).toEqual([tab]);
  expect(localStorage.getItem("marxen.workspace-metadata.v1")).not.toContain('"text"');
});
