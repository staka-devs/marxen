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
  // These tests verify the GUI-to-gateway contract with an in-memory adapter;
  // they do not source a config in real Neovim or prove native fingerprint enforcement.
  it.each([" ", "\\", ",", ";"])("saves the real common leader %j through the mocked fingerprint gateway", async (leader) => {
    const gateway = fakeGateway({ ...defaultRead(), raw: '" unmanaged 日本語\r\nset number\r\n' });
    await renderHost(gateway);
    expect(screen.getByLabelText("リーダーキー")).toHaveValue("<Space>");
    fireEvent.change(screen.getByLabelText("よく使うリーダーキー"), { target: { value: leader } });
    expect(latest?.settings.leader).toBe(leader);
    fireEvent.click(screen.getByRole("button", { name: "管理ブロックを保存する" }));
    await waitFor(() => expect(gateway.managedWrites).toHaveLength(1));
    expect(gateway.managedWrites[0]).toMatchObject({ expected: "fp1", settings: { leader } });
    expect(latest?.loaded?.raw.startsWith('" unmanaged 日本語\r\nset number\r\n')).toBe(true);
  });

  it("accepts Space notation, custom Unicode and focuses custom input", async () => {
    await renderHost(fakeGateway(defaultRead()));
    const input = screen.getByLabelText("リーダーキー");
    fireEvent.change(screen.getByLabelText("よく使うリーダーキー"), { target: { value: "custom" } });
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole("button", { name: "管理ブロックを保存する" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "<space>" } });
    expect(input).toHaveValue("<Space>"); expect(latest?.settings.leader).toBe(" ");
    expect(screen.getByRole("button", { name: "管理ブロックを保存する" })).not.toBeDisabled();
    fireEvent.change(input, { target: { value: "🚀" } });
    expect(latest?.settings.leader).toBe("🚀");
    expect(screen.getByLabelText("よく使うリーダーキー")).toHaveValue("custom");
    fireEvent.change(input, { target: { value: "<Tab>" } });
    expect(screen.getByRole("button", { name: "管理ブロックを保存する" })).toBeDisabled();
  });

  it("keeps full mapping mode names and individually labelled mapping controls", async () => {
    await renderHost(fakeGateway(defaultRead()));
    fireEvent.click(screen.getByRole("button", { name: "マッピングを追加する" }));
    expect(screen.getByLabelText("マッピング1のモード")).toHaveTextContent("nnoremap");
    fireEvent.change(screen.getByLabelText("マッピング1のキー"), { target: { value: "<Leader>w" } });
    fireEvent.change(screen.getByLabelText("マッピング1の内容"), { target: { value: ":w<CR>" } });
    expect(latest?.settings.mappings).toEqual([{ mode: "n", lhs: "<Leader>w", rhs: ":w<CR>" }]);
    fireEvent.click(screen.getByRole("button", { name: "マッピング1を削除する" }));
    expect(latest?.settings.mappings).toEqual([]);
  });

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
