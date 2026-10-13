import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResizableAiPane } from "./ResizableAiPane";

/** Supply the pointer identity missing from JSDOM while preserving browser mouse coordinates. */
class TestPointerEvent extends MouseEvent {
  pointerId: number;
  /** Capture coordinates and the pointer identifier provided by each test gesture. */
  constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
}
beforeEach(() => {
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  vi.stubGlobal("innerWidth", 1024);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** Keep width controlled so repeated pointer and keyboard updates exercise rendered bounds. */
function Harness({ onWidth }: {
  /** Record requested widths for persistence assertions. */
  onWidth: (width: number) => void;
}) {
  const [width, setWidth] = useState(360);
  return <ResizableAiPane visible width={width} onWidth={(next) => { onWidth(next); setWidth(next); }}><input aria-label="Retained conversation" defaultValue="draft" /></ResizableAiPane>;
}
describe("right chat resizing", () => {
  it("uses captured pointer movement, clamps bounds, ignores other pointers and releases capture", () => {
    const onWidth = vi.fn(); render(<Harness onWidth={onWidth} />);
    const splitter = screen.getByRole("separator");
    fireEvent.pointerDown(splitter, { pointerId: 7, button: 0, clientX: 800 });
    expect(splitter.setPointerCapture).toHaveBeenCalledWith(7);
    fireEvent.pointerMove(splitter, { pointerId: 8, clientX: 600 }); expect(onWidth).not.toHaveBeenCalled();
    fireEvent.pointerMove(splitter, { pointerId: 7, clientX: 600 }); expect(onWidth).toHaveBeenLastCalledWith(560);
    fireEvent.pointerMove(splitter, { pointerId: 7, clientX: 0 }); expect(onWidth).toHaveBeenLastCalledWith(720);
    fireEvent.pointerUp(splitter, { pointerId: 7 }); expect(splitter.releasePointerCapture).toHaveBeenCalledWith(7);
    fireEvent.pointerMove(splitter, { pointerId: 7, clientX: 900 }); expect(onWidth).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("Retained conversation")).toHaveValue("draft");
  });
  it("supports arrows, accelerated steps, Home/End and reset", () => {
    const onWidth = vi.fn(); render(<Harness onWidth={onWidth} />);
    const splitter = screen.getByRole("separator");
    fireEvent.keyDown(splitter, { key: "ArrowLeft" }); expect(splitter).toHaveAttribute("aria-valuenow", "376");
    fireEvent.keyDown(splitter, { key: "ArrowRight", shiftKey: true }); expect(splitter).toHaveAttribute("aria-valuenow", "312");
    fireEvent.keyDown(splitter, { key: "Home" }); expect(splitter).toHaveAttribute("aria-valuenow", "280");
    fireEvent.keyDown(splitter, { key: "End" }); expect(splitter).toHaveAttribute("aria-valuenow", "720");
    fireEvent.doubleClick(splitter); expect(onWidth).toHaveBeenLastCalledWith(360);
    fireEvent.keyDown(splitter, { key: "End" }); fireEvent.keyDown(splitter, { key: "Enter" }); expect(onWidth).toHaveBeenLastCalledWith(360);
  });
  it("temporarily clamps narrow windows and preserves a persisted wider width and mounted state", () => {
    const onWidth = vi.fn();
    const { rerender } = render(<ResizableAiPane visible width={600} onWidth={onWidth}><input aria-label="Draft" defaultValue="draft" /></ResizableAiPane>);
    vi.stubGlobal("innerWidth", 320); fireEvent(window, new Event("resize"));
    expect(screen.getByTestId("ai-sidebar")).toHaveStyle({ width: "320px" }); expect(onWidth).not.toHaveBeenCalled();
    rerender(<ResizableAiPane visible={false} width={600} onWidth={onWidth}><input aria-label="Draft" defaultValue="draft" /></ResizableAiPane>);
    expect(screen.getByTestId("ai-sidebar")).toHaveAttribute("aria-hidden", "true");
    rerender(<ResizableAiPane visible width={600} onWidth={onWidth}><input aria-label="Draft" defaultValue="draft" /></ResizableAiPane>);
    vi.stubGlobal("innerWidth", 1024); fireEvent(window, new Event("resize"));
    expect(screen.getByTestId("ai-sidebar")).toHaveStyle({ width: "600px" }); expect(screen.getByLabelText("Draft")).toHaveValue("draft");
  });
});
