import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { VimConfigRead, VimSettings } from "../../contracts/vim-settings";
import type { VimSettingsGateway } from "../../application/vim-settings/ports";
import { defaultVimSettings, rewriteManagedBlock } from "../../domain/vim-settings";
import { VimSettingsPanel } from "./VimSettingsPanel";
import { useVimSettings, type VimSettingsModel } from "./useVimSettings";

/**
 * Build a controllable in-memory gateway for panel assertions.
 */
function fakeGateway(read: VimConfigRead): VimSettingsGateway & { saved: string[]; managedWrites: Array<{ expected: string | null; settings: VimSettings }> } {
  const saved: string[] = [];
  const managedWrites: Array<{ expected: string | null; settings: VimSettings }> = [];
  let current = read;
  return {
    saved,
    managedWrites,
    /** In-memory config read tracking the latest written fingerprint. */
    read: async (path) => ({ ...current, path: path ?? current.path }),
    /** Recording managed write advancing the stored fingerprint. */
    writeManaged: async (path, expected, settings) => {
      saved.push(`managed:${expected}:${settings.tabstop}`);
      managedWrites.push({ expected, settings });
      const raw = rewriteManagedBlock(current.raw, settings, current.isLua);
      current = { ...current, fingerprint: "fp2", raw, settings };
      return { path: path ?? current.path, fingerprint: "fp2", raw };
    },
    /** Recording raw write storing the verbatim text. */
    writeRaw: async (path, expected, raw) => {
      saved.push(`raw:${expected}:${raw.length}`);
      current = { ...current, fingerprint: "fp3", raw };
      return { path: path ?? current.path, fingerprint: "fp3", raw };
    },
  };
}

/**
 * Default loaded file: an existing vimrc without a managed block.
 */
function defaultRead(): VimConfigRead {
  return {
    path: "/cfg/.vimrc",
    fingerprint: "fp1",
    exists: true,
    isLua: false,
    raw: "set number\n",
    settings: defaultVimSettings(),
    managedError: null,
  };
}

/** Latest hook model captured by the host for direct assertions. */
let latest: VimSettingsModel | null = null;

/**
 * Host wiring the hook to the panel exactly like the root integration.
 *
 * The host re-renders the panel on every hook update, so saved notices and
 * validation flow without manual syncing.
 */
function Host({ gateway }: { gateway: VimSettingsGateway }) {
  const model = useVimSettings({ gateway });
  latest = model;
  return <VimSettingsPanel model={model} />;
}

/**
 * Render the host and wait for the first native load to settle.
 */
async function renderHost(gateway: VimSettingsGateway) {
  latest = null;
  const view = render(<Host gateway={gateway} />);
  await waitFor(() => expect(latest?.loaded).not.toBeNull());
  return view;
}

describe("vim settings panel", () => {
  it("offers only text editing and preserves complete Vimscript with the loaded fingerprint", async () => {
    const gateway = fakeGateway(defaultRead());
    await renderHost(gateway);
    expect(screen.queryByLabelText("リーダーキー")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "管理ブロックを保存する" })).not.toBeInTheDocument();
    const code = 'let mapleader = " "\nfunction! MarxenSave()\n  Marxen file-save\nendfunction\nnoremap <Leader>w :call MarxenSave()<CR>\n';
    fireEvent.change(screen.getByLabelText("Vim設定ファイルの設定コード"), { target: { value: code } });
    expect(screen.getByRole("button", { name: "Vim詳細設定を再読込する" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "設定コードを保存する" }));
    await waitFor(() => expect(gateway.saved).toHaveLength(1));
    expect(gateway.saved[0]).toBe(`raw:fp1:${code.length}`);
    expect(latest?.rawDraft).toBe(code);
    expect(gateway.managedWrites).toHaveLength(0);
  });

  it("saves Lua and arbitrary Vimscript without managed-block validation", async () => {
    await renderHost(fakeGateway({ ...defaultRead(), path: "/cfg/init.lua", isLua: true, raw: "vim.g.mapleader = ' '\n", managedError: "old managed block" }));
    const code = "vim.keymap.set('n', '<leader>w', function() vim.cmd('Marxen file-save') end)\n";
    fireEvent.change(screen.getByLabelText("Vim設定ファイルの設定コード"), { target: { value: code } });
    fireEvent.click(screen.getByRole("button", { name: "設定コードを保存する" }));
    await waitFor(() => expect(latest?.rawDirty).toBe(false));
    expect(latest?.rawDraft).toBe(code);
  });
});
