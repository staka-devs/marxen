import { act, waitFor } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { VimConfigRead, VimConfigWrite } from "../../contracts/vim-settings";
import type { VimSettingsGateway } from "../../application/vim-settings/ports";
import { defaultVimSettings } from "../../domain/vim-settings";
import { useVimSettings } from "./useVimSettings";

/**
 * Build a failing gateway that always rejects reads.
 */
function failingGateway(): VimSettingsGateway {
  return {
    /** Read rejecting every load for failure assertions. */
    read: async () => {
      throw new Error("設定ファイルを読めません。");
    },
    /** Unused managed write for the failing fixture. */
    writeManaged: async () => ({ path: "<standard>", fingerprint: "fp2", raw: "" }),
    /** Unused raw write for the failing fixture. */
    writeRaw: async () => ({ path: "<standard>", fingerprint: "fp3", raw: "" }),
  };
}

/**
 * Build a stale gateway whose managed write always conflicts.
 */
function staleGateway(): VimSettingsGateway {
  return {
    /** Stale-baseline read fixture for conflict assertions. */
    read: async (path) => ({
      path: path ?? "<standard>",
      fingerprint: "fp-stale",
      exists: true,
      isLua: false,
      raw: "set number\n",
      settings: defaultVimSettings(),
      managedError: null,
    }),
    /** Managed write always conflicting for stale assertions. */
    writeManaged: async () => {
      throw new Error("設定ファイルが外部で変更されています。再読込してください。");
    },
    /** Unused raw write for the stale fixture. */
    writeRaw: async () => ({ path: "<standard>", fingerprint: "fp3", raw: "" }),
  };
}

describe("useVimSettings", () => {
  it("fences late reads and refuses to save another path before it is loaded", async () => {
    const pending = new Map<string, (read: VimConfigRead) => void>();
    const writeRaw = vi.fn();
    const gateway: VimSettingsGateway = {
      /** Hold individual config reads so they can complete out of order. */
      read: (path) => new Promise((resolve) => { pending.set(path!, resolve); }),
      writeManaged: vi.fn(),
      writeRaw,
    };
    const { result } = renderHook(() => useVimSettings({ gateway, initialPath: "/a/.vimrc" }));
    await waitFor(() => expect(pending.has("/a/.vimrc")).toBe(true));
    act(() => result.current.setSelectedPath("/b/.vimrc"));
    await waitFor(() => expect(pending.has("/b/.vimrc")).toBe(true));
    await act(async () => { await result.current.saveRaw(); });
    expect(writeRaw).not.toHaveBeenCalled();
    const baseline = { fingerprint: "fp-b", exists: true, isLua: false, raw: "set number", settings: defaultVimSettings(), managedError: null };
    await act(async () => { pending.get("/b/.vimrc")!({ ...baseline, path: "/b/.vimrc" }); });
    await act(async () => { pending.get("/a/.vimrc")!({ ...baseline, path: "/a/.vimrc", fingerprint: "fp-a", raw: "old" }); });
    expect(result.current.loaded?.path).toBe("/b/.vimrc");
    expect(result.current.rawDraft).toBe("set number");
    expect(result.current.busy).toBe(false);
  });

  it("preserves unsaved code instead of overwriting it with a managed save", async () => {
    const gateway = staleGateway();
    const writeManaged = vi.fn(); gateway.writeManaged = writeManaged;
    const { result } = renderHook(() => useVimSettings({ gateway }));
    await waitFor(() => expect(result.current.loaded).not.toBeNull());
    act(() => result.current.setRawDraft("set number\nlet g:custom = 1\n"));
    await act(async () => { await result.current.saveManaged(); });
    expect(writeManaged).not.toHaveBeenCalled();
    expect(result.current.error).toContain("未保存");
    expect(result.current.rawDraft).toContain("g:custom");
  });

  it("prevents duplicate writes and keeps the selected path stable while writing", async () => {
    const gateway = staleGateway();
    let finish!: (result: VimConfigWrite) => void;
    /** Hold the config write while checking duplicate requests and path changes. */
    const writeRaw = vi.fn(() => new Promise<VimConfigWrite>((resolve) => { finish = resolve; }));
    gateway.writeRaw = writeRaw;
    const { result } = renderHook(() => useVimSettings({ gateway, initialPath: "/a/.vimrc" }));
    await waitFor(() => expect(result.current.loaded).not.toBeNull());
    act(() => result.current.setRawDraft("set number\nset cursorline\n"));
    let saving!: Promise<void>;
    act(() => { saving = result.current.saveRaw(); result.current.setSelectedPath("/b/.vimrc"); void result.current.saveRaw(); });
    expect(result.current.selectedPath).toBe("/a/.vimrc");
    expect(writeRaw).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ path: "/a/.vimrc", fingerprint: "next", raw: "set number\nset cursorline\n" }); await saving; });
    expect(result.current.busy).toBe(false);
  });
  it("loads the selected config and resets drafts from the read", async () => {
    const gateway: VimSettingsGateway = {
      /** Eight-space settings read for draft assertions. */
      read: async (path) => ({
        path: path ?? "<standard>",
        fingerprint: "fp1",
        exists: true,
        isLua: false,
        raw: "set number\n",
        settings: { ...defaultVimSettings(), tabstop: 8 },
        managedError: null,
      }),
      /** Unused managed write for the load fixture. */
      writeManaged: async () => ({ path: "<standard>", fingerprint: "fp2", raw: "" }),
      /** Unused raw write for the load fixture. */
      writeRaw: async () => ({ path: "<standard>", fingerprint: "fp3", raw: "" }),
    };
    const { result } = renderHook(() => useVimSettings({ gateway }));
    await waitFor(() => expect(result.current.loaded).not.toBeNull());
    expect(result.current.settings.tabstop).toBe(8);
    expect(result.current.rawDraft).toBe("set number\n");
    expect(result.current.changed).toBe(true);
    expect(result.current.preview).toContain("set tabstop=8");
  });

  it("surfaces read failures without throwing", async () => {
    const { result } = renderHook(() => useVimSettings({ gateway: failingGateway() }));
    await waitFor(() => expect(result.current.error).toBe("設定ファイルを読めません。"));
    expect(result.current.loaded).toBeNull();
  });

  it("surfaces stale write conflicts on managed saves", async () => {
    const { result } = renderHook(() => useVimSettings({ gateway: staleGateway() }));
    await waitFor(() => expect(result.current.loaded).not.toBeNull());
    await act(async () => {
      await result.current.saveManaged();
    });
    expect(result.current.error).toContain("外部で変更");
  });
});
