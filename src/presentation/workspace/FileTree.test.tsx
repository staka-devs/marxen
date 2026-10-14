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

it("roves visible rows, expands and collapses folders, and opens only on Enter", () => {
  const open = vi.fn(); const selected = vi.fn();
  render(<FileTree rootName="workspace" nodes={buildTree(entries)} activePath={null} onOpenFile={open} onSelect={selected} />);
  const root = screen.getByRole("button", { name: "workspace" }); root.focus();
  fireEvent.keyDown(root, { key: "ArrowDown" });
  const notes = screen.getByRole("button", { name: "notes" }); expect(notes).toHaveFocus();
  fireEvent.keyDown(notes, { key: "ArrowRight" });
  fireEvent.keyDown(notes, { key: "ArrowRight" });
  const file = screen.getByRole("button", { name: "notes/readme.md" }); expect(file).toHaveFocus();
  expect(open).not.toHaveBeenCalled();
  fireEvent.keyDown(file, { key: "Enter" }); expect(open).toHaveBeenCalledExactlyOnceWith("notes/readme.md");
  fireEvent.keyDown(file, { key: "ArrowLeft" }); expect(notes).toHaveFocus();
  fireEvent.keyDown(notes, { key: "ArrowLeft" }); expect(screen.queryByRole("button", { name: "notes/readme.md" })).toBeNull();
  fireEvent.keyDown(notes, { key: "Home" }); expect(root).toHaveFocus();
  expect(within(screen.getByRole("tree")).getAllByRole("button").filter((button) => button.tabIndex === 0)).toHaveLength(1);
});

it("captures pointer and keyboard contexts, preserves focus on Escape, and routes F2", () => {
  const open = vi.fn(); const run = vi.fn(); const select = vi.fn();
  render(<FileTree nodes={buildTree(entries)} activePath="config.json" onOpenFile={open} onSelect={select} onCommand={run} contextCommands={() => [
    { id: "file-rename", menu: "file", label: "名前を変更", enabled: true },
    { id: "unsupported", menu: "file", label: "無効な操作", enabled: false },
  ]} />);
  const row = screen.getByRole("button", { name: "notes/readme.md" });
  fireEvent.contextMenu(row, { clientX: 20, clientY: 30 });
  expect(open).not.toHaveBeenCalled(); expect(select).toHaveBeenLastCalledWith(expect.objectContaining({ path: "notes/readme.md" }));
  const rename = screen.getByRole("menuitem", { name: "名前を変更" }); expect(rename).toHaveFocus();
  fireEvent.click(screen.getByRole("menuitem", { name: "無効な操作" })); expect(run).not.toHaveBeenCalled();
  fireEvent.keyDown(rename, { key: "Escape" }); expect(row).toHaveFocus();
  fireEvent.keyDown(row, { key: "F2" }); expect(run).toHaveBeenCalledWith("file-rename", expect.objectContaining({ path: "notes/readme.md" }));
  fireEvent.keyDown(row, { key: "F10", shiftKey: true }); expect(screen.getByRole("menu", { name: "エクスプローラーの操作" })).toBeVisible();
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "名前を変更" }), { key: "Escape" });
  fireEvent.keyDown(row, { key: "ContextMenu" }); expect(screen.getByRole("menuitem", { name: "名前を変更" })).toHaveFocus();
});
