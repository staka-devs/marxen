import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { buildTree, FileTree } from "./FileTree";
import { WORKSPACE_IMAGE_DRAG } from "../../domain/workspace-files";

const entries = [
  { path: "notes", name: "notes", directory: true, markdown: false },
  { path: "notes/readme.md", name: "readme.md", directory: false, markdown: true },
  { path: "config.json", name: "config.json", directory: false, markdown: false },
  { path: "photo.png", name: "photo.png", directory: false, markdown: false },
  { path: "app.exe", name: "app.exe", directory: false, markdown: false },
];
it("shows folders first with Lucide type icons, filters binaries and marks the selected row", () => {
  const open = vi.fn();
  render(<FileTree nodes={buildTree(entries)} activePath="config.json" onOpenFile={open} />);
  expect(screen.getAllByRole("treeitem")[0]).toHaveAttribute("aria-expanded", "true");
  expect(screen.queryByRole("button", { name: "app.exe" })).toBeNull();
  const selected = screen.getByRole("button", { name: "config.json" });
  expect(selected).toHaveAttribute("aria-current", "true");
  expect(selected.querySelector("svg[data-file-icon]")).toHaveAttribute("data-file-icon", "text");
  expect(screen.getByRole("button", { name: "notes" }).querySelector("svg[data-file-icon]")).toHaveAttribute("data-file-icon", "folder-open");
  expect(screen.getByRole("button", { name: "notes/readme.md" }).querySelector("svg[data-file-icon]")).toHaveAttribute("data-file-icon", "markdown");
  fireEvent.click(selected);
  expect(open).toHaveBeenCalledWith("config.json");
  fireEvent.click(screen.getByRole("button", { name: "notes" }));
  expect(screen.queryByRole("button", { name: "notes/readme.md" })).toBeNull();
});
it("starts an internal image drag with a workspace path instead of file bytes", () => {
  render(<FileTree nodes={buildTree(entries)} activePath="photo.png" onOpenFile={() => {}} />);
  const transfer = { setData: vi.fn(), effectAllowed: "" };
  fireEvent.dragStart(screen.getByRole("button", { name: "photo.png" }), { dataTransfer: transfer });
  expect(transfer.setData).toHaveBeenCalledWith(WORKSPACE_IMAGE_DRAG, "photo.png");
  expect(transfer.effectAllowed).toBe("copy");
  expect(within(screen.getByRole("tree")).getByRole("button", { name: "photo.png" })).toHaveAttribute("draggable", "true");
});
