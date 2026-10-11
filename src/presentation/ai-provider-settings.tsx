import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
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
}

const KIND_ORDER: AiProviderKind[] = ["acp", "openai_compatible", "anthropic"];

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
export default function AiProviderSettings({ provider, onProvider, openToken, gateway, profileStore }: AiProviderSettingsProps) {
  const [kind, setKind] = useState<AiProviderKind>(provider.kind);
  const [preset, setPreset] = useState<AcpPreset>(provider.acp?.preset ?? "codex");
  const [command, setCommand] = useState(provider.acp?.argv?.command ?? "");
  const [argsText, setArgsText] = useState((provider.acp?.argv?.args ?? []).join("\n"));
  const [endpoint, setEndpoint] = useState(
    provider.openai?.endpoint ?? provider.anthropic?.endpoint ?? DEFAULT_ENDPOINTS.openai_compatible,
  );
  const [model, setModel] = useState(provider.openai?.model ?? provider.anthropic?.model ?? "");
  const [anthropicEnabled, setAnthropicEnabled] = useState(provider.anthropic?.enabled ?? false);
  const [credential, setCredentialState] = useState<CredentialRef | null>(null);
  const [secretInput, setSecretInput] = useState("");
  const [credentialMessage, setCredentialMessage] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<AiTestResult | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [liveConfirm, setLiveConfirm] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (openToken !== undefined && openToken > 0) detailsRef.current?.setAttribute("open", "");
  }, [openToken]);

  useEffect(() => {
    try {
      profileStore?.save({ kind, preset, command, argsText, endpoint, model, anthropicEnabled });
    } catch {
      // Private mode/quota: profiles simply do not persist.
    }
    onProvider(buildProviderConfig({ kind, preset, command, argsText, endpoint, model, anthropicEnabled }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, preset, command, argsText, endpoint, model, anthropicEnabled]);

  /**
   * Refresh credential presence through the injected gateway.
   *
   * Without a gateway (tests, browser demo) reports that desktop is required.
   */
  async function refreshCredential() {
    if (!gateway) {
      setCredentialMessage("AI 機能はデスクトップアプリで利用します。");
      return;
    }
    try {
      setCredentialState(await gateway.getCredentialState(kind));
      setCredentialMessage(null);
    } catch (cause) {
      setCredentialMessage(describeInvokeError(cause));
    }
  }

  /**
   * Save the typed secret to the OS store without ever displaying it.
   *
   * Clears the input on success; failures surface as helper text.
   */
  async function handleSaveCredential() {
    if (!gateway) {
      setCredentialMessage("AI 機能はデスクトップアプリで利用します。");
      return;
    }
    try {
      await gateway.setCredential(kind, secretInput);
      setSecretInput("");
      await refreshCredential();
      setCredentialMessage("資格情報を OS ストアに保存しました。値は表示しません。");
    } catch (cause) {
      setCredentialMessage(describeInvokeError(cause));
    }
  }

  /**
   * Delete the stored secret for the current kind.
   *
   * Refreshes presence afterwards so the UI never shows a stale value.
   */
  async function handleDeleteCredential() {
    if (!gateway) {
      setCredentialMessage("AI 機能はデスクトップアプリで利用します。");
      return;
    }
    try {
      await gateway.deleteCredential(kind);
      await refreshCredential();
      setCredentialMessage("資格情報を削除しました。");
    } catch (cause) {
      setCredentialMessage(describeInvokeError(cause));
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
    try {
      if (!gateway) throw new Error("AI 機能はデスクトップアプリで利用します。");
      setTestResult(await gateway.testConnection(provider, live));
    } catch (cause) {
      setTestResult({ ok: false, detail: describeInvokeError(cause) });
    } finally {
      setTestBusy(false);
    }
  }

  const claudeBlocked = kind === "acp" && preset === "custom" && isClaudeCommand(command);

  return (
    <details ref={detailsRef} data-testid="ai-provider-settings" className="max-h-[45dvh] overflow-y-auto rounded-md border border-border">
      <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium">接続設定</summary>
      <div className="space-y-3 border-t border-border p-2">
        <div role="group" aria-label="接続先">
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
                if (candidate === "anthropic") setEndpoint(DEFAULT_ENDPOINTS.anthropic);
                else if (candidate === "openai_compatible") setEndpoint(DEFAULT_ENDPOINTS.openai_compatible);
              }}
            >
              {candidate === "acp" ? "ACP" : candidate === "openai_compatible" ? "OpenAI 互換" : "Anthropic"}
            </Button>
          ))}
        </div>
        {kind === "acp" ? (
          <div className="space-y-2">
            <label className="block text-xs">
              プリセット
              <select
                aria-label="ACP プリセット"
                className="mt-1 block w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs"
                value={preset}
                onChange={(event) => setPreset(event.target.value as AcpPreset)}
              >
                {(Object.keys(PRESET_LABELS) as AcpPreset[]).map((candidate) => (
                  <option key={candidate} value={candidate}>{PRESET_LABELS[candidate]}</option>
                ))}
              </select>
            </label>
            {preset === "custom" ? (
              <>
                <label className="block text-xs">
                  コマンド (シェルを介さず直接起動します)
                  <input
                    aria-label="カスタムコマンド"
                    className="mt-1 block w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs"
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    placeholder="my-agent"
                  />
                </label>
                <label className="block text-xs">
                  引数 (1 行 1 引数)
                  <textarea
                    aria-label="カスタム引数"
                    className="mt-1 block w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs"
                    rows={2}
                    value={argsText}
                    onChange={(event) => setArgsText(event.target.value)}
                    placeholder={"--stdio\n--model mock"}
                  />
                </label>
                {claudeBlocked && <p className="text-xs text-red-600">Claude コマンドは起動しません。</p>}
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                {preset === "codex"
                  ? "codex-acp アダプターを利用者が事前にインストールします。自動取得はしません。"
                  : "OpenCode を opencode acp として起動します。"}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {kind === "anthropic" && (
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={anthropicEnabled} onChange={(event) => setAnthropicEnabled(event.target.checked)} />
                Anthropic を有効化する (opt-in)
              </label>
            )}
            <label className="block text-xs">
              endpoint
              <input
                aria-label="endpoint"
                className="mt-1 block w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs"
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                placeholder={DEFAULT_ENDPOINTS[kind]}
              />
            </label>
            <label className="block text-xs">
              model
              <input
                aria-label="model"
                className="mt-1 block w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="model-id"
              />
            </label>
          </div>
        )}
        <div className="border-t border-border pt-2">
          <p className="text-xs font-medium">資格情報 (OS ストア)</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {credential === null ? "状態を確認してください。値は表示しません。" : credential.hasSecret ? "保存済み。値は表示しません。" : "未保存。"}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            <Button variant="outline" size="sm" onClick={() => void refreshCredential()}>状態を確認</Button>
            <Button variant="outline" size="sm" onClick={() => void handleDeleteCredential()}>削除</Button>
          </div>
          <div className="mt-1 flex gap-1">
            <input
              aria-label="資格情報の入力"
              type="password"
              autoComplete="off"
              className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1.5 text-xs"
              value={secretInput}
              onChange={(event) => setSecretInput(event.target.value)}
              placeholder="API キーなど"
            />
            <Button size="sm" onClick={() => void handleSaveCredential()} disabled={secretInput.length === 0}>保存</Button>
          </div>
          {credentialMessage && <p className="mt-1 text-[11px] text-muted-foreground">{credentialMessage}</p>}
        </div>
        <div className="border-t border-border pt-2">
          <p className="text-xs font-medium">接続テスト</p>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <Button variant="outline" size="sm" onClick={() => void handleTest(false)} disabled={testBusy}>設定を確認</Button>
            <label className="flex items-center gap-1 text-[11px]">
              <input type="checkbox" checked={liveConfirm} onChange={(event) => setLiveConfirm(event.target.checked)} />
              実際に接続する
            </label>
            <Button variant="outline" size="sm" onClick={() => void handleTest(true)} disabled={testBusy || !liveConfirm}>接続テスト</Button>
          </div>
          {testResult && (
            <p role="status" className="mt-1 text-xs font-medium">{testResult.ok ? "成功" : "失敗"}: {testResult.detail}</p>
          )}
        </div>
      </div>
    </details>
  );
}
