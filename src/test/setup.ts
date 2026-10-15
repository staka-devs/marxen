import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

afterEach(cleanup);

// Existing product fixtures describe a Japanese host; locale acceptance tests override this explicitly.
beforeEach(() => {
  localStorage.removeItem("marxen.workspace-metadata.v1");
  Object.defineProperty(navigator, "language", {
    configurable: true,
    /** Report the Japanese host locale used by the existing product fixtures. */
    get: () => "ja-JP",
  });
});

// jsdom lacks layout for CodeMirror measurement (true inline widgets trigger
// ViewState.measure). Stub text-range rects so live-preview tests don't throw
// unhandled errors; native WebView layout is verified via production E2E.
if (typeof Range !== "undefined") {
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  }
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () => new DOMRect();
  }
}
