import { describe, expect, it, vi } from "vitest";
import { pickConfigFile, pickFolder } from "./dialog";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  /** Desktop transport flag for dialog tests. */
  isTauri: () => true,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

describe("native dialogs", () => {
  it("returns the picked folder path", async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockResolvedValueOnce("/chosen/workspace");
    expect(await pickFolder()).toBe("/chosen/workspace");
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ directory: true, multiple: false }));
  });

  it("returns null when the picker is cancelled", async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockResolvedValueOnce(null);
    expect(await pickFolder()).toBeNull();
    expect(await pickConfigFile()).toBeNull();
  });
});
