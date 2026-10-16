import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProviderAccountGateway } from "../../application/ai/provider-account-ports";
import type { AccountSnapshot } from "../../contracts/provider-accounts";
import { ACCOUNT_PROVIDERS } from "../../domain/provider-accounts";
import { ProviderAccountsSettings } from "./ProviderAccounts";

afterEach(cleanup);

/** Native fixture stores metadata separately from secrets, matching the Rust IPC boundary. */
function fixture() {
  const state: AccountSnapshot = { accounts: [], selections: [] };
  const gateway: ProviderAccountGateway = {
    /** Record setup actions without opening any real browser or signing in. */
    openSetup: vi.fn(async () => undefined),
    /** Read fixture metadata without returning secret inputs. */
    snapshot: vi.fn(async () => structuredClone(state)),
    /** Simulate Rust-issued IDs and preserve a secret only as presence metadata. */
    save: vi.fn(async (account, secret) => {
      const index = state.accounts.findIndex(s => s.account.id === account.id);
      const saved = { account: { ...account, id: account.id || "a".repeat(32), revision: account.revision + 1 }, hasCredential: !!secret || (index >= 0 && state.accounts[index].hasCredential) };
      if (index < 0) state.accounts.push(saved); else state.accounts[index] = saved;
    }),
    /** Preserve the same provider and host in selection fixtures. */
    select: vi.fn(async selection => { state.selections = [selection]; }),
    /** Simulate native account deletion and system-default selection reset. */
    delete: vi.fn(async id => { state.accounts = state.accounts.filter(s => s.account.id !== id); state.selections = state.selections.map(s => ({ ...s, accountId: s.accountId === id ? null : s.accountId })); }),
    /** Presence alone does not claim authenticated server access. */
    credentialPresent: vi.fn(async () => true),
    /** Return only a synthetic measured quota. */
    usage: vi.fn(async () => ({ quotas: [{ label: "fixture quota", usedPercent: 25, resetsAt: null }], receivedMs: 1792159200000, unavailableReason: null })),
  };
  return { gateway, state };
}

/** Choose one account provider through the same control used by end users. */
function chooseProvider(id: string) { fireEvent.change(screen.getByLabelText("プロバイダーアカウント", { selector: "select" }), { target: { value: id } }); }

describe("provider accounts", () => {
  it.each(ACCOUNT_PROVIDERS)("offers complete setup, secret and usage controls for $label", async spec => {
    const { gateway } = fixture();
    render(<ProviderAccountsSettings gateway={gateway} />);
    await waitFor(() => expect(gateway.snapshot).toHaveBeenCalled());
    chooseProvider(spec.id);
    const setup = screen.getByRole("link", { name: "公式の設定・使用量ページ" });
    expect(setup.getAttribute("href")).toBe(spec.docs);
    fireEvent.click(setup);
    await waitFor(() => expect(gateway.openSetup).toHaveBeenCalledWith(spec.id));
    await waitFor(() => expect((screen.getByRole("button", { name: "アカウントを追加" }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole("button", { name: "使用量を更新" }) as HTMLButtonElement).disabled).toBe(!spec.usage);
    fireEvent.click(screen.getByRole("button", { name: "アカウントを追加" }));
    fireEvent.change(screen.getByLabelText("アカウント名"), { target: { value: `${spec.label} work` } });
    fireEvent.change(screen.getByLabelText(spec.credential), { target: { value: "fixture-secret-never-returned" } });
    expect(screen.getByLabelText(spec.credential).getAttribute("type")).toBe("password");
    expect((screen.getByLabelText("使用量の接続先") as HTMLSelectElement).value).toBe(spec.endpoints[0]);
    if (spec.endpoints.length > 1) fireEvent.change(screen.getByLabelText("使用量の接続先"), { target: { value: spec.endpoints[1] } });
    if (spec.id === "gemini") fireEvent.change(screen.getByLabelText("Google Cloud プロジェクト ID（任意）"), { target: { value: "fixture-project" } });
    fireEvent.click(screen.getByRole("button", { name: "アカウントを保存" }));
    await screen.findByText("アカウントを保存しました。選択すると次の起動に反映します。");
    expect(gateway.save).toHaveBeenCalledWith(expect.objectContaining({ provider: spec.id, name: `${spec.label} work`, host: { kind: "local" }, endpoint: spec.endpoints[1] ?? spec.endpoints[0] }), "fixture-secret-never-returned");
    expect(screen.queryByDisplayValue("fixture-secret-never-returned")).toBeNull();
    fireEvent.change(screen.getByLabelText("使用するアカウント"), { target: { value: "a".repeat(32) } });
    await screen.findByText("選択を保存しました。既存の会話には反映しません。");
    expect(gateway.select).toHaveBeenCalledWith({ provider: spec.id, host: { kind: "local" }, accountId: "a".repeat(32) });
    fireEvent.click(screen.getByRole("button", { name: "認証状態を確認" }));
    await waitFor(() => expect(gateway.credentialPresent).toHaveBeenCalledWith(spec.id, { kind: "local" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "認証状態を確認" }) as HTMLButtonElement).disabled).toBe(false));
    if (spec.usage) {
      fireEvent.click(screen.getByRole("button", { name: "使用量を更新" }));
      await screen.findByText("fixture quota: 25%");
      expect(gateway.usage).toHaveBeenCalledWith(spec.id, { kind: "local" });
    }
    fireEvent.click(screen.getByRole("button", { name: "アカウントを削除" }));
    expect(gateway.delete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "削除を確定" }));
    await screen.findByText("管理アカウントを削除しました。システム既定のログインは変更しません。");
    expect(gateway.delete).toHaveBeenCalledWith("a".repeat(32));
    expect((screen.getByLabelText("使用するアカウント") as HTMLSelectElement).value).toBe("");
  });

  it("keeps WSL settings separate and explains unsupported actions", async () => {
    const { gateway } = fixture(); render(<ProviderAccountsSettings gateway={gateway} />);
    fireEvent.change(screen.getByLabelText("認証スコープ"), { target: { value: "wsl" } });
    expect((screen.getByRole("button", { name: "アカウントを追加" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("WSL ディストリビューション"), { target: { value: "Ubuntu" } });
    expect(screen.getByText(/WSL アダプターは未対応/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "使用量を更新" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "アカウントを追加" }));
    fireEvent.change(screen.getByLabelText("アカウント名"), { target: { value: "WSL work" } });
    fireEvent.click(screen.getByRole("button", { name: "アカウントを保存" }));
    await screen.findByText("アカウントを保存しました。選択すると次の起動に反映します。");
    expect(gateway.save).toHaveBeenCalledWith(expect.objectContaining({ host: { kind: "wsl", distribution: "Ubuntu" } }), undefined);
    expect(gateway.usage).not.toHaveBeenCalled();
  });

  it("never renders raw backend errors or stale account usage", async () => {
    const { gateway } = fixture();
    let resolveUsage!: (value: Awaited<ReturnType<ProviderAccountGateway["usage"]>>) => void;
    gateway.usage = vi.fn(() => new Promise<Awaited<ReturnType<ProviderAccountGateway["usage"]>>>(resolve => { resolveUsage = resolve; }));
    gateway.credentialPresent = vi.fn(async () => { throw { code: "store_failed", detail: "fixture-secret-in-backend-error" }; });
    render(<ProviderAccountsSettings gateway={gateway} />);
    fireEvent.click(screen.getByRole("button", { name: "認証状態を確認" }));
    await screen.findByText("アカウント操作に失敗しました。保存先と接続を確認してください。");
    expect(screen.queryByText(/fixture-secret-in-backend-error/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "使用量を更新" }));
    chooseProvider("cursor");
    await act(async () => resolveUsage({ quotas: [{ label: "stale-codex", usedPercent: 90, resetsAt: null }], receivedMs: 10, unavailableReason: null }));
    expect(screen.queryByText(/stale-codex/)).toBeNull();
  });

  it("clears entered credentials on save failure and preserves the chosen account", async () => {
    const { gateway } = fixture(); gateway.save = vi.fn(async () => { throw { code: "credential_store_failed", detail: "secret" }; });
    render(<ProviderAccountsSettings gateway={gateway} />); chooseProvider("cursor");
    fireEvent.click(screen.getByRole("button", { name: "アカウントを追加" }));
    fireEvent.change(screen.getByLabelText("アカウント名"), { target: { value: "work" } });
    fireEvent.change(screen.getByLabelText("Cursor の Cookie ヘッダー（WorkosCursorSessionToken）"), { target: { value: "fixture-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "アカウントを保存" }));
    await screen.findByText("OS 資格情報ストアを利用できません。ロック状態を確認してください。");
    expect(screen.queryByDisplayValue("fixture-secret")).toBeNull(); expect(gateway.select).not.toHaveBeenCalled();
  });

  it("shows unavailable usage without a fabricated zero or progress bar", async () => {
    const { gateway } = fixture(); gateway.usage = vi.fn(async () => ({ quotas: [], receivedMs: 0, unavailableReason: "invalid_response" as const }));
    render(<ProviderAccountsSettings gateway={gateway} />);
    fireEvent.click(screen.getByRole("button", { name: "使用量を更新" }));
    await screen.findByText("使用量の応答形式に対応していません。値は表示しません。");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("offers desktop-required status with native actions disabled in browser demos", () => {
    render(<ProviderAccountsSettings />);
    expect(screen.getByText("AI 機能はデスクトップアプリで利用します。")).toBeTruthy();
    expect((screen.getByRole("button", { name: "アカウントを追加" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
