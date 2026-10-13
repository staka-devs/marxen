import { describe, expect, it, vi } from "vitest";
import type { VimSettingsGateway } from "./ports";
import { defaultVimSettings } from "../../domain/vim-settings";
import {
  checkVimSettings,
  previewVimSettings,
  saveManagedVimSettings,
  saveRawVimSettings,
} from "./vim-settings-service";

/**
 * Build a recording in-memory gateway for use-case assertions.
 */
function fakeGateway(): VimSettingsGateway & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    /** In-memory config read with a fixed fingerprint for assertions. */
    read: async (path) => ({
      path: path ?? "<standard>",
      fingerprint: "fp1",
      exists: true,
      isLua: false,
      raw: "set number\n",
      settings: defaultVimSettings(),
      managedError: null,
    }),
    /** Recording managed write returning a fresh fingerprint. */
    writeManaged: async (path, expected, settings) => {
      calls.push(`managed:${path}:${expected}:${settings.tabstop}`);
      return { path: path ?? "<standard>", fingerprint: "fp2", raw: "set number\n" };
    },
    /** Recording raw write returning a fresh fingerprint. */
    writeRaw: async (path, expected, raw) => {
      calls.push(`raw:${path}:${expected}:${raw.length}`);
      return { path: path ?? "<standard>", fingerprint: "fp3", raw };
    },
  };
}

describe("vim-settings service", () => {
  it("validates locally before a managed save", async () => {
    const gateway = fakeGateway();
    await expect(
      saveManagedVimSettings(gateway, null, "fp1", { ...defaultVimSettings(), tabstop: 0 }),
    ).rejects.toThrow();
    expect(gateway.calls).toHaveLength(0);
  });

  it("refuses managed saves to Lua targets", async () => {
    const gateway = fakeGateway();
    await expect(
      saveManagedVimSettings(gateway, "/cfg/init.lua", "fp1", defaultVimSettings()),
    ).rejects.toThrow("init.lua");
    expect(checkVimSettings(defaultVimSettings())).toEqual([]);
  });

  it("delegates guarded writes and previews purely", async () => {
    const gateway = fakeGateway();
    const spy = vi.spyOn(gateway, "writeManaged");
    await saveManagedVimSettings(gateway, null, "fp1", defaultVimSettings());
    expect(spy).toHaveBeenCalledOnce();
    await saveRawVimSettings(gateway, null, "fp1", "vim.opt.number = true\n");
    expect(gateway.calls.some((call) => call.startsWith("raw:"))).toBe(true);
    const { changed } = previewVimSettings("set number\n", defaultVimSettings(), "/cfg/.vimrc");
    expect(changed).toBe(true);
    expect(() => previewVimSettings("x", defaultVimSettings(), "/cfg/init.lua")).toThrow();
  });
});
