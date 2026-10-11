import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { buildTree, FileTree } from "./FileTree";
import { ImageDropZone } from "./ImageDropZone";
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }) }));
it("keeps native external file drop enabled while a desktop internal pointer drag inserts once", () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  const drop = vi.fn(); const open = vi.fn();
  render(<>
    <FileTree nodes={buildTree([{ path: "a.png", name: "a.png", directory: false, markdown: false }])} activePath={null} onOpenFile={open} />
    <ImageDropZone enabled selection={{ start: 2, end: 2 }} onDrop={drop} onError={vi.fn()}><span>Markdown editor</span></ImageDropZone>
  </>);
  const image = screen.getByRole("button", { name: "a.png" });
  vi.spyOn(screen.getByTestId("image-drop-zone"), "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 200, 200));
  fireEvent.pointerDown(image, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
  expect(fireEvent.dragStart(image, { dataTransfer: { setData: vi.fn() } })).toBe(false);
  fireEvent.pointerMove(image, { clientX: 150, clientY: 150, pointerId: 1 });
  fireEvent.pointerUp(image, { clientX: 150, clientY: 150, pointerId: 1 });
  fireEvent.click(image);
  expect(drop).toHaveBeenCalledExactlyOnceWith({ kind: "workspace", path: "a.png" }, { start: 2, end: 2 });
  expect(open).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
