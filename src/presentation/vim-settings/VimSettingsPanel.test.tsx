import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { VimConfigRead } from "../../contracts/vim-settings";
import type { VimSettingsGateway } from "../../application/vim-settings/ports";
import { defaultVimSettings } from "../../domain/vim-settings";
import { VimSettingsPanel } from "./VimSettingsPanel";
import { useVimSettings, type VimSettingsModel } from "./useVimSettings";

/**
 * Build a controllable in-memory gateway for panel assertions.
 */
function fakeGateway(read: VimConfigRead): VimSettingsGateway & { saved: string[] } {
  const saved: string[] = [];
  let current = read;
  return {
    saved,
    /** In-memory config read tracking the latest written fingerprint. */
    read: async (path) => ({ ...current, path: path ?? current.path }),
    /** Recording managed write advancing the stored fingerprint. */
    writeManaged: async (path, expected, settings) => {
      saved.push(`managed:${expected}:${settings.tabstop}`);
      current = { ...current, fingerprint: "fp2" };
      return { path: path ?? current.path, fingerprint: "fp2", raw: "next" };
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
  it("edits indent controls and saves the managed block", async () => {
    const gateway = fakeGateway(defaultRead());
    await renderHost(gateway);
    fireEvent.change(screen.getByLabelText("タブ幅"), { target: { value: "4" } });
    expect(latest?.settings.tabstop).toBe(4);
    fireEvent.click(screen.getByRole("button", { name: "管理ブロックを保存する" }));
    await waitFor(() => expect(gateway.saved.some((call) => call.startsWith("managed:fp1:4"))).toBe(true));
    await waitFor(() =>
      expect(screen.getByText("管理ブロックを保存しました。設定の適用でNeovimを再起動します。")).toBeVisible(),
    );
  });

  it("disables structured controls on Lua targets but keeps the raw editor", async () => {
    const gateway = fakeGateway({
      ...defaultRead(),
      path: "/cfg/init.lua",
      isLua: true,
      raw: "vim.opt.number = true\n",
    });
    await renderHost(gateway);
    expect(screen.getByLabelText("タブ幅")).toBeDisabled();
    expect(screen.getByLabelText("Vim設定ファイルの設定コード")).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "管理ブロックを保存する" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "設定コードを保存する" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Vim設定ファイルの設定コード"), {
      target: { value: "vim.opt.number = false\n" },
    });
    expect(screen.getByRole("button", { name: "設定コードを保存する" })).not.toBeDisabled();
  });

  it("surfaces validation errors and blocks the managed save", async () => {
    const gateway = fakeGateway(defaultRead());
    await renderHost(gateway);
    fireEvent.change(screen.getByLabelText("タブ幅"), { target: { value: "99" } });
    expect(await screen.findAllByText("tabstop は 1〜32 で指定してください。")).not.toHaveLength(0);
    expect(screen.getByRole("button", { name: "管理ブロックを保存する" })).toBeDisabled();
  });

  it("shows managed parse failures while keeping raw saving available", async () => {
    const gateway = fakeGateway({
      ...defaultRead(),
      raw: "bad block",
      managedError: "管理ブロックのマーカーが重複または不足しています。",
    });
    await renderHost(gateway);
    expect(screen.getByText("管理ブロックのマーカーが重複または不足しています。")).toBeVisible();
    expect(screen.getByRole("button", { name: "管理ブロックを保存する" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "設定コードを保存する" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Vim設定ファイルの設定コード"), {
      target: { value: "set number\n" },
    });
    expect(screen.getByRole("button", { name: "設定コードを保存する" })).not.toBeDisabled();
  });

  it("edits the raw text and saves it verbatim", async () => {
    const gateway = fakeGateway(defaultRead());
    await renderHost(gateway);
    fireEvent.change(screen.getByLabelText("Vim設定ファイルの設定コード"), {
      target: { value: "set number\nset relativenumber\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "設定コードを保存する" }));
    await waitFor(() => expect(gateway.saved.some((call) => call.startsWith("raw:fp1:"))).toBe(true));
  });
});
