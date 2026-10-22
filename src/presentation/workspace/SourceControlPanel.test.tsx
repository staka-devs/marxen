import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SourceControlPanel } from "./SourceControlPanel";
import type { GitStatus, WorkspaceInfo } from "../../contracts/contracts";

afterEach(cleanup);

const root = { root: "C:/work/notes", scope: { rootId: "root-1", generation: "1" } } as WorkspaceInfo;

it("lists changes with their branch and shows a colored diff on demand", async () => {
  const status: GitStatus = { repository: true, branch: "main", changes: [{ path: "docs/a.md", status: "M" }, { path: "new.md", status: "?" }] };
  /** Return a one-line modification diff. */
  const gitDiff = vi.fn(async () => "@@ -1 +1 @@\n-old\n+new\n");
  const onOpen = vi.fn();
  const gateway = {
    /** Report the fixed repository status. */
    gitStatus: async () => status,
    gitDiff,
  };
  render(<SourceControlPanel roots={[root]} gateway={gateway} refreshKey="" onOpen={onOpen} />);
  expect(await screen.findByText("main")).toBeVisible();
  expect(screen.getByText("notes")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /^a\.md/, expanded: false }));
  expect(gitDiff).toHaveBeenCalledWith(root.scope, "docs/a.md", "M");
  expect(await screen.findByText("+new")).toHaveClass("marxen-diff-add");
  expect(screen.getByText("-old")).toHaveClass("marxen-diff-del");
  fireEvent.click(screen.getByRole("button", { name: "new.md を開く" }));
  expect(onOpen).toHaveBeenCalledWith("new.md", root.scope);
});

it("explains folders outside Git and clean work trees", async () => {
  const other = { ...root, root: "C:/work/plain", scope: { rootId: "root-2", generation: "1" } } as WorkspaceInfo;
  /** Report a clean repository for root-1 and a plain folder otherwise. */
  const gitStatus = vi.fn(async (scope: WorkspaceInfo["scope"]) => (scope.rootId === "root-1"
    ? { repository: true, branch: "main", changes: [] }
    : { repository: false, branch: null, changes: [] }));
  render(<SourceControlPanel roots={[root, other]} gateway={{ gitStatus }} refreshKey="" onOpen={vi.fn()} />);
  expect(await screen.findByText("変更はありません。")).toBeVisible();
  expect(await screen.findByText("Git リポジトリではありません。")).toBeVisible();
});
