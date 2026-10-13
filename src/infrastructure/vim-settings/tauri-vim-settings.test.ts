import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { vimSettingsGateway } from "./tauri-vim-settings";
import { defaultVimSettings } from "../../domain/vim-settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

describe("tauri vim-settings gateway", () => {
  it("sends fingerprint-guarded managed writes with the selected path", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(invoke).mockResolvedValue({ path: "/cfg/.vimrc", fingerprint: "fp2", raw: "next" });
    const settings = defaultVimSettings();
    const result = await vimSettingsGateway.writeManaged("/cfg/.vimrc", "fp1", settings);
    expect(invoke).toHaveBeenCalledWith("vim_settings_write_managed", {
      path: "/cfg/.vimrc",
      expectedFingerprint: "fp1",
      settings,
    });
    expect(result.fingerprint).toBe("fp2");
  });

  it("reads through the native command and keeps null for the standard config", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(invoke).mockResolvedValue({
      path: "<standard>",
      fingerprint: null,
      exists: false,
      isLua: false,
      raw: "",
      settings: defaultVimSettings(),
      managedError: null,
    });
    const read = await vimSettingsGateway.read(null);
    expect(invoke).toHaveBeenCalledWith("vim_settings_read", { path: null });
    expect(read.exists).toBe(false);
  });

  it("writes raw Lua text verbatim through the guarded command", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(invoke).mockResolvedValue({ path: "/cfg/init.lua", fingerprint: "fp9", raw: "vim.opt.number = true\n" });
    const result = await vimSettingsGateway.writeRaw("/cfg/init.lua", null, "vim.opt.number = true\n");
    expect(invoke).toHaveBeenCalledWith("vim_settings_write_raw", {
      path: "/cfg/init.lua",
      expectedFingerprint: null,
      raw: "vim.opt.number = true\n",
    });
    expect(result.raw).toContain("vim.opt.number");
  });

  it("refuses IPC outside Tauri so the demo fails loudly", async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    await expect(vimSettingsGateway.read(null)).rejects.toThrow("デスクトップ");
    await expect(vimSettingsGateway.writeRaw(null, null, "x")).rejects.toThrow("デスクトップ");
  });
});
