import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { readRuntimeStatus } from "./runtime";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

describe("runtime transport", () => {
  it("reports browser disconnection without invoking a desktop command", async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    expect(await readRuntimeStatus()).toMatchObject({ connection: "disconnected" });
    expect(invoke).not.toHaveBeenCalled();
  });
  it("uses the Rust command in Tauri and propagates command errors", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(invoke).mockRejectedValue(new Error("IPC unavailable"));
    await expect(readRuntimeStatus()).rejects.toThrow("IPC unavailable");
    expect(invoke).toHaveBeenCalledWith("get_runtime_status");
  });
});
