import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AiUsagePopover } from "./AiUsagePopover";
import { I18nProvider } from "../i18n/I18nProvider";
import { createTranslator } from "../../infrastructure/localization/i18next-translator";
import type { AiUsageGateway, CodexAccountUsageGateway, TranscriptUsageGateway } from "../../application/ai/usage-ports";
import type { Language } from "../../contracts/language";
import type { TranscriptUsageReport } from "../../contracts/ai-contracts";

/** Render the actual popup through its injected translation and metadata ports. */
function renderUsage(gateway: AiUsageGateway, accountGateway?: CodexAccountUsageGateway, language: Language = "ja-JP", transcriptGateway?: TranscriptUsageGateway) {
  return render(<I18nProvider language={language} createTranslator={createTranslator}><AiUsagePopover gateway={gateway} accountGateway={accountGateway} transcriptGateway={transcriptGateway} theme="dark" /></I18nProvider>);
}

it("distinguishes account quota from context and displays only reported counters", async () => {
  const cleanup = vi.fn();
  const gateway: AiUsageGateway = {
    /** Report context and token scopes separately for one session. */
    snapshot: vi.fn<AiUsageGateway["snapshot"]>(async () => [
      { provider: "acp", preset: "opencode", runId: "run", sessionId: "session", source: "usage_update", scope: "session", used: 25, size: 100, cost: { amount: "0.0012", currency: "USD" }, receivedMs: 1 },
      { provider: "acp", preset: "opencode", runId: "run", sessionId: "session", source: "prompt_response", scope: "prompt_response_undefined", inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedReadTokens: 0, receivedMs: 2 },
    ]),
    /** Return the owned listener cleanup. */
    subscribe: vi.fn(async () => cleanup),
  };
  const account: CodexAccountUsageGateway = {
    /** Report an independent account window with no fabricated credit balance. */
    read: vi.fn(async () => ({ buckets: [{ id: "codex", primary: { usedPercent: 58, windowDurationMins: 300 } }], receivedMs: 1 })),
  };
  renderUsage(gateway, account);
  const trigger = screen.getByRole("button", { name: "使用量" });
  fireEvent.click(trigger);
  const popup = await screen.findByRole("dialog", { name: "使用量" });
  expect(await within(popup).findByRole("heading", { name: "OpenCode" })).toBeVisible();
  expect(within(popup).getByRole("progressbar", { name: "コンテキスト使用率" })).toHaveAttribute("aria-valuenow", "25");
  expect(within(popup).getByRole("progressbar", { name: "利用枠の使用率" })).toHaveAttribute("aria-valuenow", "58");
  expect(within(popup).getByText("0.0012 USD")).toBeVisible();
  expect(within(popup).getByText("キャッシュ読み取り")).toBeVisible();
  expect(within(popup).queryByText("キャッシュ書き込み")).not.toBeInTheDocument();
  expect(within(popup).queryByText("クレジット残高")).not.toBeInTheDocument();
  fireEvent.click(within(popup).getByRole("button", { name: "コンパクト" }));
  expect(gateway.snapshot).toHaveBeenCalledOnce();
  expect(account.read).toHaveBeenCalledOnce();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "使用量" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(cleanup).toHaveBeenCalledOnce();
});

it("keeps absent usage absent instead of displaying zero-filled bars or costs", async () => {
  const gateway: AiUsageGateway = {
    /** Report no observed session usage. */
    snapshot: vi.fn<AiUsageGateway["snapshot"]>(async () => []),
    /** Return an inert listener cleanup. */
    subscribe: vi.fn(async () => vi.fn()),
  };
  renderUsage(gateway, undefined, "en-US");
  fireEvent.click(screen.getByRole("button", { name: "Usage" }));
  const popup = await screen.findByRole("dialog", { name: "Usage" });
  expect(await within(popup).findByText("No usage reported yet.")).toBeVisible();
  expect(within(popup).queryByRole("progressbar")).not.toBeInTheDocument();
  expect(within(popup).queryByText("Credit balance")).not.toBeInTheDocument();
  expect(within(popup).queryByText("Session cost")).not.toBeInTheDocument();
  expect(within(popup).getByRole("button", { name: "Refresh usage" })).toBeEnabled();
});

it("reports a failed account read while retaining valid session observations", async () => {
  const gateway: AiUsageGateway = {
    /** Return a genuine zero-valued context observation. */
    snapshot: vi.fn<AiUsageGateway["snapshot"]>(async () => [{ provider: "acp", preset: "copilot", runId: "run", sessionId: "session", source: "usage_update", scope: "session", used: 0, size: 100, receivedMs: 1 }]),
    /** Return an inert listener cleanup. */
    subscribe: vi.fn(async () => vi.fn()),
  };
  const account: CodexAccountUsageGateway = {
    /** Simulate an unavailable account without reporting balances or limits. */
    read: vi.fn(async () => { throw new Error("unavailable"); }),
  };
  renderUsage(gateway, account);
  fireEvent.click(screen.getByRole("button", { name: "使用量" }));
  expect(await screen.findByText("Codex の利用枠を取得できませんでした。")).toBeVisible();
  await waitFor(() => expect(screen.getByRole("progressbar", { name: "コンテキスト使用率" })).toHaveAttribute("aria-valuenow", "0"));
  expect(screen.getByRole("heading", { name: "GitHub Copilot" })).toBeVisible();
  expect(screen.queryByRole("progressbar", { name: "利用枠の使用率" })).not.toBeInTheDocument();
});

it("shows measured local transcript totals with honest gaps per agent", async () => {
  const gateway: AiUsageGateway = {
    /** Report no observed session usage. */
    snapshot: vi.fn<AiUsageGateway["snapshot"]>(async () => []),
    /** Return an inert listener cleanup. */
    subscribe: vi.fn(async () => vi.fn()),
  };
  const report: TranscriptUsageReport = {
    agents: [
      { agent: "claude", sessions: [{ sessionId: "s1", model: "sonnet", tokens: { inputTokens: 100, outputTokens: 20 }, updatedMs: 1791635527568 }], truncated: false, scannedFiles: 2 },
      { agent: "copilot", sessions: [], truncated: false, reason: "no_token_data", scannedFiles: 0 },
      { agent: "opencode", sessions: [], truncated: false, reason: "store_missing", scannedFiles: 0 },
    ],
    receivedMs: 9,
  };
  const transcript: TranscriptUsageGateway = {
    /** Report fixture transcript totals without touching native stores. */
    read: vi.fn<TranscriptUsageGateway["read"]>(async () => report),
  };
  renderUsage(gateway, undefined, "ja-JP", transcript);
  fireEvent.click(screen.getByRole("button", { name: "使用量" }));
  const popup = await screen.findByRole("dialog", { name: "使用量" });
  expect(await within(popup).findByText("アプリ内の利用")).toBeVisible();
  // Claude Code appears as an unavailable quota and as an in-app transcript row.
  expect(within(popup).getAllByText("Claude Code")).toHaveLength(2);
  expect(within(popup).getAllByText("利用枠: 取得不可")).toHaveLength(3);
  expect(within(popup).getByText("アプリ内で使った記録はありません。")).toBeVisible();
  expect(within(popup).getByText("記録がありません。")).toBeVisible();
  expect(transcript.read).toHaveBeenCalledOnce();
});
