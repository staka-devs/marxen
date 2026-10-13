import type { LocalizedText } from "../contracts/localization";
import { localizedFailure, renderLocalizedText } from "../domain/localization";
import type { LabelKey } from "../contracts/localization";
import { localizedException } from "../domain/localized-error";
import type { Translator } from "../contracts/localization";
import { japaneseTranslator } from "../domain/localization";
import { useI18n } from "./i18n/I18nProvider";
import { createPortal } from "react-dom";
import { trapDialogTab } from "./workspace/dialogFocus";
import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Settings } from "lucide-react";
import {
  DEFAULT_ENDPOINTS,
  PRESET_LABELS,
  buildProviderConfig,
  describeInvokeError,
  isClaudeCommand,
} from "../domain/ai-config";
import { defaultProfile, sanitizeAiProfile, type AiProfile } from "../domain/ai-profile";
import type {
  AcpPreset,
  AiProviderConfig,
  AiProviderKind,
  AiTestResult,
  CredentialRef,
} from "../contracts/ai-contracts";
import type { AiGateway, AiProfileStore } from "../application/ports";

export interface AiProviderSettingsProps {
  provider: AiProviderConfig;
  /** Replace the edited provider configuration. */
  onProvider: (provider: AiProviderConfig) => void;
  /** Increment to expand the collapsed settings from outside (e.g. root Settings). */
  openToken?: number;
  /** Credential/connection gateway injected by the composition root. */
  gateway?: Pick<AiGateway, "getCredentialState" | "setCredential" | "deleteCredential" | "testConnection">;
  /** Non-secret profile store injected by the composition root. */
  profileStore?: AiProfileStore;
  /** Render the shared connection fields directly in the main settings page. */
  embedded?: boolean;
  /** Show an icon trigger in the chat header instead of the full connection summary. */
  compact?: boolean;
}

const KIND_ORDER: AiProviderKind[] = ["acp", "openai_compatible", "anthropic"];

/**
 * Describe the active connection in one neutral line without claiming success.
 *
 * Shows the preset or model/endpoint fragment only; liveness comes from an
 * explicit connection test and is never invented here.
 */
export function describeProviderSummary(provider: AiProviderConfig, t: Translator = japaneseTranslator): string {
  if (provider.kind === "acp") {
    if (provider.acp?.preset === "custom") {
      const command = provider.acp.argv?.command?.trim() ?? "";
      return command === "" ? t("カスタム") : t("カスタム • {{value0}}", { value0: (command) });
    }
    return t(PRESET_LABELS[provider.acp?.preset ?? "codex"] as LabelKey);
  }
  if (provider.kind === "openai_compatible") {
    const model = provider.openai?.model?.trim() ?? "";
    return model === "" ? t("OpenAI互換") : t("OpenAI互換 • {{value0}}", { value0: (model) });
  }
  const model = provider.anthropic?.model?.trim() ?? "";
  const enabled = provider.anthropic?.enabled ?? false;
  if (!enabled) return model === "" ? t("Anthropic（無効）") : t("Anthropic • {{value0}}（無効）", { value0: (model) });
  return model === "" ? "Anthropic" : `Anthropic • ${model}`;
}

/**
 * Build the initial provider config from the injected store or defaults.
 *
 * Falls back to Codex defaults when no store is wired (tests, browser demo).
 */
export function providerFromProfile(store?: AiProfileStore): AiProviderConfig {
  let saved: AiProfile;
  try {
    saved = store?.load() ?? defaultProfile();
  } catch {
    saved = defaultProfile();
  }
  try {
    return buildProviderConfig(saved);
  } catch {
    return buildProviderConfig(defaultProfile());
  }
}

/**
 * Load a profile through the store with sanitization fallback.
 *
 * Exported for AiPanel's uncontrolled initial state without importing storage.
 */
export function loadProfileForPanel(store?: AiProfileStore): AiProfile {
  try {
    return store?.load() ?? defaultProfile();
  } catch {
    return defaultProfile();
  }
}

/**
 * Validate a raw profile payload without touching storage.
 *
 * Used by tests to assert sanitization without localStorage side effects.
 */
export function sanitizeProfileForTest(raw: unknown): AiProfile {
  return sanitizeAiProfile(raw);
}

/**
 * Provider connection settings with OS credential store and connection tests.
 *
 * All native calls go through the injected `gateway`; profile persistence
 * goes through `profileStore`. No direct Tauri or storage imports.
 */
export default function AiProviderSettings({ provider, onProvider, openToken, gateway, profileStore, embedded = false, compact = false }: AiProviderSettingsProps) {
  const { t, message } = useI18n();
  const [kind, setKind] = useState<AiProviderKind>(provider.kind);
  const [preset, setPreset] = useState<AcpPreset>(provider.acp?.preset ?? "codex");
  const [command, setCommand] = useState(provider.acp?.argv?.command ?? "");
  const [argsText, setArgsText] = useState((provider.acp?.argv?.args ?? []).join("\n"));
  const [endpoint, setEndpoint] = useState(
    provider.openai?.endpoint ?? provider.anthropic?.endpoint ?? DEFAULT_ENDPOINTS.openai_compatible,
  );
  const [model, setModel] = useState(provider.openai?.model ?? provider.anthropic?.model ?? "");
  const [anthropicEnabled, setAnthropicEnabled] = useState(provider.anthropic?.enabled ?? false);
  const [acpSelections, setAcpSelections] = useState(provider.acp?.selections);
  const [credential, setCredentialState] = useState<CredentialRef | null>(null);
  const [secretInput, setSecretInput] = useState("");
  const [credentialMessage, setCredentialMessage] = useState<LocalizedText | null>(null);
  const [testResult, setTestResult] = useState<AiTestResult | null>(null);
  const [testFailure, setTestFailure] = useState<LocalizedText | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [liveConfirm, setLiveConfirm] = useState(false);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  const publishedProvider = useRef(provider);

  useEffect(() => {
    if (JSON.stringify(provider) === JSON.stringify(publishedProvider.current)) return;
    publishedProvider.current = provider;
    setKind(provider.kind);
    setPreset(provider.acp?.preset ?? "codex");
    setCommand(provider.acp?.argv?.command ?? "");
    setArgsText((provider.acp?.argv?.args ?? []).join("\n"));
    setEndpoint(provider.openai?.endpoint ?? provider.anthropic?.endpoint ?? DEFAULT_ENDPOINTS.openai_compatible);
    setModel(provider.openai?.model ?? provider.anthropic?.model ?? "");
    setAnthropicEnabled(provider.anthropic?.enabled ?? false);
    setAcpSelections(provider.acp?.selections);
    setCredentialState(null);
    setTestResult(null);
    setTestFailure(null);
  }, [provider]);

  useEffect(() => {
    if (openToken !== undefined && openToken > 0) setOpen(true);
  }, [openToken]);

  useEffect(() => {
    if (!open || embedded) return;
    openerRef.current = document.activeElement;
    dialogRef.current?.focus();
    /**
     * Close the settings dialog on Escape without touching the draft.
     *
     * Registered in the capture phase so the shell's global shortcuts never
     * fire first; focus restoration runs in the effect cleanup below.
     */
    const onKey = (event: KeyboardEvent) => {
      trapDialogTab(event, dialogRef.current);
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const opener = openerRef.current as HTMLElement | null;
      if (opener && typeof opener.focus === "function") opener.focus();
      else triggerRef.current?.focus();
    };
  }, [open, embedded]);

  useEffect(() => {
    try {
      profileStore?.save({ kind, preset, command, argsText, endpoint, model, anthropicEnabled, acpSelections });
    } catch {
      // Private mode/quota: profiles simply do not persist.
    }
    const next = buildProviderConfig({ kind, preset, command, argsText, endpoint, model, anthropicEnabled, acpSelections });
    if (JSON.stringify(next) !== JSON.stringify(publishedProvider.current)) {
      publishedProvider.current = next;
      onProvider(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, preset, command, argsText, endpoint, model, anthropicEnabled, acpSelections]);

  /**
   * Open the settings dialog, keeping the collapsed trigger quiet.
   *
   * Focus moves into the dialog via the open effect; the previously focused
   * element is stored there so closing restores it.
   */
  function openSettings() {
    setOpen(true);
  }

  /**
   * Close the settings dialog and restore focus to the trigger.
   *
   * Draft field state is preserved; only visibility changes so an
   * accidental close never discards edits.
   */
  function closeSettings() {
    setOpen(false);
  }

  /**
   * Refresh credential presence through the injected gateway.
   *
   * Without a gateway (tests, browser demo) reports that desktop is required.
   */
  async function refreshCredential() {
    if (!gateway) {
      setCredentialMessage(message("AI 機能はデスクトップアプリで利用します。"));
      return;
    }
    try {
      setCredentialState(await gateway.getCredentialState(kind));
      setCredentialMessage(null);
    } catch (cause) {
      setCredentialMessage(localizedFailure(cause, describeInvokeError));
    }
  }

  /**
   * Save the typed secret to the OS store without ever displaying it.
   *
   * Clears the input on success; failures surface as helper text.
   */
  async function handleSaveCredential() {
    if (!gateway) {
      setCredentialMessage(message("AI 機能はデスクトップアプリで利用します。"));
      return;
    }
    try {
      await gateway.setCredential(kind, secretInput);
      setSecretInput("");
      await refreshCredential();
      setCredentialMessage(message("資格情報を OS ストアに保存しました。値は表示しません。"));
    } catch (cause) {
      setCredentialMessage(localizedFailure(cause, describeInvokeError));
    }
  }

  /**
   * Delete the stored secret for the current kind.
   *
   * Refreshes presence afterwards so the UI never shows a stale value.
   */
  async function handleDeleteCredential() {
    if (!gateway) {
      setCredentialMessage(message("AI 機能はデスクトップアプリで利用します。"));
      return;
    }
    try {
      await gateway.deleteCredential(kind);
      await refreshCredential();
      setCredentialMessage(message("資格情報を削除しました。"));
    } catch (cause) {
      setCredentialMessage(localizedFailure(cause, describeInvokeError));
    }
  }

  /**
   * Test the provider connection, optionally with a live probe.
   *
   * Without a gateway reports failure instead of throwing, so settings stay open.
   */
  async function handleTest(live: boolean) {
    setTestBusy(true);
    setTestResult(null);
    setTestFailure(null);
    try {
      if (!gateway) throw localizedException(t, "AI 機能はデスクトップアプリで利用します。");
      setTestResult(await gateway.testConnection(provider, live));
    } catch (cause) {
      setTestFailure(localizedFailure(cause, describeInvokeError));
      setTestResult({ ok: false, detail: describeInvokeError(cause, t) });
    } finally {
      setTestBusy(false);
    }
  }

  const claudeBlocked = kind === "acp" && preset === "custom" && isClaudeCommand(command);
  const summary = describeProviderSummary(provider, t);

  const fields = (
      <div className={embedded ? "space-y-4" : "space-y-2.5 px-2.5 py-2"}>
        <div role="group" aria-label={t("接続先")}>
          {KIND_ORDER.map((candidate) => (
            <Button
              key={candidate}
              variant={candidate === kind ? "default" : "outline"}
              size="sm"
              className="mb-1 mr-1"
              aria-pressed={candidate === kind}
              onClick={() => {
                setKind(candidate);
                setCredentialState(null);
                setTestResult(null);
                setTestFailure(null);
                if (candidate === "anthropic") setEndpoint(DEFAULT_ENDPOINTS.anthropic);
                else if (candidate === "openai_compatible") setEndpoint(DEFAULT_ENDPOINTS.openai_compatible);
              }}
            >
              {candidate === "acp" ? "ACP" : candidate === "openai_compatible" ? t("OpenAI 互換") : "Anthropic"}
            </Button>
          ))}
        </div>
        {kind === "acp" ? (
          <div className="space-y-2">
            <label className="block text-xs">
              {t("プリセット")}<select
                aria-label={t("ACP プリセット")}
                className="mt-1 block w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs"
                value={preset}
                onChange={(event) => { setPreset(event.target.value as AcpPreset); setAcpSelections(undefined); }}
              >
                {(Object.keys(PRESET_LABELS) as AcpPreset[]).map((candidate) => (
                  <option key={candidate} value={candidate}>{t(PRESET_LABELS[candidate] as LabelKey)}</option>
                ))}
              </select>
            </label>
            {preset === "custom" ? (
              <>
                <label className="block text-xs">
                  {t("コマンド (シェルを介さず直接起動します)")}<input
                    aria-label={t("カスタムコマンド")}
                    className="mt-1 block w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs"
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    placeholder="my-agent"
                  />
                </label>
                <label className="block text-xs">
                  {t("引数 (1 行 1 引数)")}<textarea
                    aria-label={t("カスタム引数")}
                    className="mt-1 block w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs"
                    rows={2}
                    value={argsText}
                    onChange={(event) => setArgsText(event.target.value)}
                    placeholder="--stdio"
                  />
                </label>
                {claudeBlocked && <p className="text-xs text-red-600">{t("Claude コマンドは起動しません。")}</p>}
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                {preset === "codex"
                  ? t("codex-acp アダプターを利用者が事前にインストールします。自動取得はしません。")
                  : t("OpenCode を opencode acp として起動します。")}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {kind === "anthropic" && (
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={anthropicEnabled} onChange={(event) => setAnthropicEnabled(event.target.checked)} />
                {t("Anthropic API を有効にする")}</label>
            )}
            <label className="block text-xs">
              {t("API エンドポイント")}<input
                aria-label={t("API エンドポイント")}
                className="mt-1 block w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs"
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                placeholder={DEFAULT_ENDPOINTS[kind]}
              />
            </label>
            <label className="block text-xs">
              {t("モデル")}<input
                aria-label={t("モデル")}
                className="mt-1 block w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="model-id"
              />
            </label>
          </div>
        )}
        {kind !== "acp" && <div className="border-t border-border pt-2">
          <p className="text-xs font-medium">{t("API キー")}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {credential === null ? t("状態を確認してください。値は表示しません。") : credential.hasSecret ? t("保存済み。値は表示しません。") : t("未保存。")}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            <Button variant="outline" size="sm" onClick={() => void refreshCredential()}>{t("状態を確認")}</Button>
            <Button variant="outline" size="sm" onClick={() => void handleDeleteCredential()}>{t("削除")}</Button>
          </div>
          <div className="mt-1 flex gap-1">
            <input
              aria-label={t("資格情報の入力")}
              type="password"
              autoComplete="off"
              className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1.5 text-xs"
              value={secretInput}
              onChange={(event) => setSecretInput(event.target.value)}
              placeholder={t("API キーなど")}
            />
            <Button size="sm" onClick={() => void handleSaveCredential()} disabled={secretInput.length === 0}>{t("保存")}</Button>
          </div>
          {credentialMessage && <p className="mt-1 text-[11px] text-muted-foreground">{renderLocalizedText(credentialMessage, t)}</p>}
          <p className="mt-2 text-xs text-muted-foreground">{t("OS の資格情報ストアに保存します。")}</p>
        </div>}
        <div className="border-t border-border pt-2">
          <p className="text-xs font-medium">{t("接続テスト")}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <Button variant="outline" size="sm" onClick={() => void handleTest(false)} disabled={testBusy}>{t("設定を確認")}</Button>
            <label className="flex items-center gap-1 text-[11px]">
              <input type="checkbox" checked={liveConfirm} onChange={(event) => setLiveConfirm(event.target.checked)} />
              {t("実際に接続する")}</label>
            <Button variant="outline" size="sm" onClick={() => void handleTest(true)} disabled={testBusy || !liveConfirm}>{t("接続テスト")}</Button>
          </div>
          {testResult && (
            <p role="status" className="mt-1 text-xs font-medium">{testResult.ok ? t("成功") : t("失敗")}: {testFailure === null ? testResult.detail : renderLocalizedText(testFailure, t)}</p>
          )}
        </div>
      </div>
  );
  return embedded ? <div data-testid="ai-provider-settings">{fields}</div> : (
    <div data-testid="ai-provider-settings" className={compact ? "inline-flex" : "ai-provider-settings"}>
      <button
        ref={triggerRef}
        type="button"
        onClick={openSettings}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("接続設定を開く")}
        title={t("接続設定 · {{value0}}", { value0: (summary) })}
        className={compact ? "rounded-sm p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" : "ai-provider-trigger flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs"}
      >
        {compact ? <Settings size={15} aria-hidden="true" /> : <><span className="shrink-0 font-medium">{t("接続設定")}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-normal text-muted-foreground">• {summary}</span></>}
      </button>
      {open && createPortal(
        <div
          className="ai-provider-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeSettings();
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={t("接続設定")}
            tabIndex={-1}
            className="ai-provider-dialog"
          >
            <div className="ai-provider-dialog-header flex shrink-0 items-center gap-1.5">
              <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold">{t("接続設定")}</h2>
              <Button variant="outline" size="sm" aria-label={t("接続設定を閉じる")} title={t("閉じる")} onClick={closeSettings} className="shrink-0">
                {t("閉じる")}</Button>
            </div>
            <div className="ai-provider-dialog-body min-h-0 overflow-y-auto">
              {fields}
            </div>
          </div>
        </div>, triggerRef.current?.closest("[data-theme]") ?? document.body
      )}
    </div>
  );
}
