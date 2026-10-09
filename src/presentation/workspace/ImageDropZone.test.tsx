import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ImageDropZone } from "./ImageDropZone";
import { WORKSPACE_IMAGE_DRAG } from "../../domain/workspace-files";

type NativeDrop = { position: { x: number; y: number }; paths: string[] };
const native = vi.hoisted(() => ({ handler: null as ((drop: NativeDrop) => void) | null, stop: vi.fn() }));
/**
 * Injected native subscription standing in for the Tauri webview transport.
 *
 * Records the handler so tests can fire drops inside/outside the editor and
 * asserts the unlisten cleanup on unmount.
 */
function subscribeNativeDrop(onDrop: (drop: NativeDrop) => void): Promise<() => void> {
  native.handler = onDrop;
  return Promise.resolve(native.stop);
}
beforeEach(() => { native.handler = null; native.stop.mockClear(); });

it("owns internal DOM drops exactly once and preserves a UTF-16 fallback selection", () => {
  const drop = vi.fn();
  render(<ImageDropZone enabled selection={{ start: 2, end: 4 }} onDrop={drop} onError={vi.fn()}><span>editor</span></ImageDropZone>);
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: [WORKSPACE_IMAGE_DRAG],
      /** Return the dragged workspace image path. */
      getData: () => "assets/a.png",
      files: [],
    },
  });
  fireEvent(screen.getByTestId("image-drop-zone"), event);
  expect(event.defaultPrevented).toBe(true);
  expect(drop).toHaveBeenCalledExactlyOnceWith({ kind: "workspace", path: "assets/a.png" }, { start: 2, end: 4 });
});

it("blocks image insertion during IME preedit and rejects unsupported external files", () => {
  const drop = vi.fn(); const error = vi.fn();
  render(<ImageDropZone enabled selection={{ start: 0, end: 0 }} onDrop={drop} onError={error}><span>editor</span></ImageDropZone>);
  const zone = screen.getByTestId("image-drop-zone");
  const transfer = {
    types: ["Files"],
    /** Return empty text so the file branch is exercised. */
    getData: () => "",
    files: [new File(["text"], "a.svg")],
  };
  fireEvent.compositionStart(zone);
  fireEvent.drop(zone, { dataTransfer: transfer });
  expect(drop).not.toHaveBeenCalled();
  fireEvent.compositionEnd(zone);
  fireEvent.drop(zone, { dataTransfer: transfer });
  expect(error).toHaveBeenCalledOnce();
  expect(drop).not.toHaveBeenCalled();
});

it("routes native absolute paths only inside the editor and removes its native listener", async () => {
  const drop = vi.fn();
  const result = render(<ImageDropZone enabled desktop subscribeNativeDrop={subscribeNativeDrop} selection={{ start: 2, end: 2 }} onDrop={drop} onError={vi.fn()}><span>editor</span></ImageDropZone>);
  const zone = screen.getByTestId("image-drop-zone");
  vi.spyOn(zone, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 200, 100));
  await waitFor(() => expect(native.handler).not.toBeNull());
  act(() => native.handler!({ position: { x: 50, y: 50 }, paths: ["C:/outside/a.png"] }));
  expect(drop).toHaveBeenCalledExactlyOnceWith({ kind: "native", paths: ["C:/outside/a.png"] }, { start: 2, end: 2 });
  act(() => native.handler!({ position: { x: 500, y: 500 }, paths: ["C:/outside/a.png"] }));
  expect(drop).toHaveBeenCalledOnce();
  result.unmount();
  expect(native.stop).toHaveBeenCalledOnce();
});
