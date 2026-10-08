import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import {
  DEFAULT_ENDPOINTS,
  PRESET_LABELS,
  buildProviderConfig,
  deleteCredential,
  describeInvokeError,
  getCredentialState,
  isClaudeCommand,
  setCredential,
  testConnection,
} from "../lib/ai";
import { loadAiProfile, saveAiProfile } from "../lib/ai-profiles";
import type {
  AcpPreset,
  AiProviderConfig,
  AiProviderKind,
  AiTestResult,
  CredentialRef,
} from "../shared/ai-contracts";

export interface AiProviderSettingsProps {
  provider: AiProviderConfig;
  onProvider: (provider: AiProviderConfig) => void;
  /** Increment to expand the collapsed settings from outside (e.g. root Settings). */
  openToken?: number;
}

const KIND_ORDER: AiProviderKind[] = ["acp", "openai_compatible", "anthropic"];

export function providerFromProfile(): AiProviderConfig {
  const saved = loadAiProfile();
  return buildProviderConfig(saved);
}

export default function AiProviderSettings({ provider, onProvider, openToken }: AiProviderSettingsProps) {
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
    saveAiProfile({ kind, preset, command, argsText, endpoint, model, anthropicEnabled });
    onProvider(buildProviderConfig({ kind, preset, command, argsText, endpoint, model, anthropicEnabled }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, preset, command, argsText, endpoint, model, anthropicEnabled]);

  async function refreshCredential() {
    try {
      setCredentialState(await getCredentialState(kind));
      setCredentialMessage(null);
    } catch (cause) {
      setCredentialMessage(describeInvokeError(cause));
    }
  }

  async function handleSaveCredential() {
    try {
      await setCredential(kind, secretInput);
      setSecretInput("");
      await refreshCredential();
      setCredentialMessage("資格情報を OS ストアに保存しました。値は表示しません。");
    } catch (cause) {
      setCredentialMessage(describeInvokeError(cause));
    }
  }

  async function handleDeleteCredential() {
    try {
      await deleteCredential(kind);
      await refreshCredential();
      setCredentialMessage("資格情報を削除しました。");
    } catch (cause) {
      setCredentialMessage(describeInvokeError(cause));
    }
  }

  async function handleTest(live: boolean) {
    setTestBusy(true);
    setTestResult(null);
    try {
      setTestResult(await testConnection(provider, live));
    } catch (cause) {
      setTestResult({ ok: false, detail: describeInvokeError(cause) });
    } finally {
      setTestBusy(false);
    }
  }

  const claudeBlocked = kind === "acp" && preset === "custom" && isClaudeCommand(command);

  return (
    <details ref={detailsRef} data-testid="ai-provider-settings" className="rounded-lg border border-border">
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
