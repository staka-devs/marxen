import { describe, expect, it, vi } from "vitest";
import { listenNativeDrop } from "./native-drop";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: vi.fn() }));

describe("native drop transport", () => {
  it("forwards only drop payloads behind lib/", async () => {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    let handler!: (event: { payload: { type: string; position: { x: number; y: number }; paths: string[] } }) => void;
    vi.mocked(getCurrentWebview).mockReturnValue({
      onDragDropEvent: vi.fn(async (callback: typeof handler) => {
        handler = callback;
        return () => undefined;
      }),
    } as never);
    const seen: Array<{ position: { x: number; y: number }; paths: string[] }> = [];
    await listenNativeDrop((drop) => seen.push(drop));
    handler({ payload: { type: "hover", position: { x: 1, y: 2 }, paths: [] } });
    handler({ payload: { type: "drop", position: { x: 3, y: 4 }, paths: ["a.png"] } });
    expect(seen).toEqual([{ position: { x: 3, y: 4 }, paths: ["a.png"] }]);
  });
});
