import { useState } from "react";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import {
  DEFAULT_ENDPOINTS,
  MODE_LABELS,
  PRESET_LABELS,
  cancelPromptSafe,
  deleteCredential,
  describeAiError,
  describeInvokeError,
  getCredentialState,
  isClaudeCommand,
  setCredential,
  startPrompt,
  summarizeContext,
  testConnection,
} from "../lib/ai";
import type {
  AcpPreset,
  AiError,
  AiPromptRequest,
  AiProviderConfig,
  AiProviderKind,
  AiStreamEvent,
  AiTestResult,
  ContextSummary,
  CredentialRef,
  PromptContext,
  PromptMode,
  ProposalText,
  StagingTarget,
} from "../shared/ai-contracts";

export interface AiPanelProps {
  contexts: PromptContext[];
  staging: StagingTarget | null;
  onRemoveContext?: (documentId: string) => void;
}

const KIND_ORDER: AiProviderKind[] = ["acp", "openai_compatible", "anthropic"];
const MODE_ORDER: PromptMode[] = ["ask", "generate", "rewrite", "workspace"];

export function buildProviderConfig(state: {
  kind: AiProviderKind;
  preset: AcpPreset;
  command: string;
  argsText: string;
  endpoint: string;
  model: string;
  anthropicEnabled: boolean;
}): AiProviderConfig {
  if (state.kind === "acp") {
    if (state.preset === "custom") {
      const args = state.argsText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      return {
        kind: "acp",
        acp: { preset: "custom", argv: { command: state.command.trim(), args } },
        openai: null,
        anthropic: null,
      };
    }
    return { kind: "acp", acp: { preset: state.preset, argv: null }, openai: null, anthropic: null };
  }
  if (state.kind === "openai_compatible") {
    return {
      kind: "openai_compatible",
      acp: null,
      openai: { endpoint: state.endpoint.trim(), model: state.model.trim() },
      anthropic: null,
    };
  }
  return {
    kind: "anthropic",
    acp: null,
    openai: null,
    anthropic: {
      enabled: state.anthropicEnabled,
      endpoint: state.endpoint.trim(),
      model: state.model.trim(),
    },
  };
}

export default function AiPanel({ contexts, staging, onRemoveContext }: AiPanelProps) {
  const [kind, setKind] = useState<AiProviderKind>("acp");
  const [preset, setPreset] = useState<AcpPreset>("codex");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINTS.openai_compatible);
  const [model, setModel] = useState("");
  const [anthropicEnabled, setAnthropicEnabled] = useState(false);
  const [credential, setCredentialState] = useState<CredentialRef | null>(null);
  const [secretInput, setSecretInput] = useState("");
  const [credentialMessage, setCredentialMessage] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<AiTestResult | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [liveConfirm, setLiveConfirm] = useState(false);
  const [mode, setMode] = useState<PromptMode>("ask");
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState("");
  const [proposal, setProposal] = useState<ProposalText | null>(null);
  const [sent, setSent] = useState<ContextSummary[]>([]);
  const [streamError, setStreamError] = useState<AiError | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [stopFn, setStopFn] = useState<(() => Promise<void>) | null>(null);

  const provider: AiProviderConfig = buildProviderConfig({
    kind,
    preset,
    command,
    argsText,
    endpoint,
    model,
    anthropicEnabled,
  });

  function handleEvent(event: AiStreamEvent) {
    switch (event.type) {
      case "started":
        setOutput("");
        setProposal(null);
        setSent([]);
        setStreamError(null);
        setCancelled(false);
        break;
      case "chunk":
        setOutput((previous) => previous + event.payload.text);
        break;
      case "done":
        setProposal(event.payload.proposal);
        setSent(event.payload.sent);
        setRunning(false);
        setStopFn(null);
        break;
      case "error":
        setStreamError(event.payload.error);
        setRunning(false);
        setStopFn(null);
        break;
      case "cancelled":
        setCancelled(true);
        setRunning(false);
        setStopFn(null);
        break;
    }
  }

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

  async function handleSend() {
    if (kind === "acp" && preset === "custom" && isClaudeCommand(command)) {
      setStreamError({ code: "claude_code_refused", command: command.trim() });
      return;
    }
    if (!staging) {
      setStreamError({
        code: "staging_unresolved",
        copy_id: "(未解決)",
      });
      return;
    }
    const request: AiPromptRequest = {
      provider,
      mode,
      prompt,
      contexts,
      staging,
      sessionId: null,
    };
    setRunning(true);
    setStreamError(null);
    try {
      const session = await startPrompt(request, handleEvent);
      setStopFn(() => session.stop);
    } catch (cause) {
      setRunning(false);
      setStreamError(
        typeof cause === "object" && cause !== null && "code" in cause
          ? (cause as AiError)
          : { code: "connection_failed", detail: describeInvokeError(cause) },
      );
    }
  }

  async function handleCancel() {
    if (stopFn) {
      await cancelPromptSafe(stopFn);
    }
  }

  const anthropicBlocked = kind === "anthropic" && !anthropicEnabled;
  const canSend = !running && prompt.trim().length > 0 && staging !== null && !anthropicBlocked;

  return (
    <Card aria-labelledby="ai-panel-title">
      <h2 id="ai-panel-title" className="text-base font-semibold">AI 支援</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        回答は提案テキストです。原文への反映は差分レビュー (#8) を経ます。
      </p>

      <div className="mt-4" role="group" aria-label="接続先">
        {KIND_ORDER.map((candidate) => (
          <Button
            key={candidate}
            variant={candidate === kind ? "default" : "outline"}
            size="sm"
            className="mr-2 mb-2"
            aria-pressed={candidate === kind}
            onClick={() => {
              setKind(candidate);
              setCredentialState(null);
              setTestResult(null);
              if (candidate === "anthropic") {
                setEndpoint(DEFAULT_ENDPOINTS.anthropic);
              } else if (candidate === "openai_compatible") {
                setEndpoint(DEFAULT_ENDPOINTS.openai_compatible);
              }
            }}
          >
            {candidate === "acp" ? "ACP" : candidate === "openai_compatible" ? "OpenAI 互換" : "Anthropic"}
          </Button>
        ))}
      </div>

      {kind === "acp" ? (
        <div className="mt-2 space-y-3">
          <label className="block text-sm">
            プリセット
            <select
              aria-label="ACP プリセット"
              className="mt-1 block w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
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
              <label className="block text-sm">
                コマンド (シェルを介さず直接起動します)
                <input
                  aria-label="カスタムコマンド"
                  className="mt-1 block w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder="my-agent"
                />
              </label>
              <label className="block text-sm">
                引数 (1 行 1 引数)
                <textarea
                  aria-label="カスタム引数"
                  className="mt-1 block w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
                  rows={3}
                  value={argsText}
                  onChange={(event) => setArgsText(event.target.value)}
                  placeholder={"--stdio\n--model mock"}
                />
              </label>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {preset === "codex"
                ? "codex-acp アダプター (@agentclientprotocol/codex-acp) を利用者が事前にインストールします。未検出時は起動せず明示し、自動取得はしません。"
                : "OpenCode を opencode acp として起動します。未検出時は起動せず明示します。"}
            </p>
          )}
        </div>
      ) : (
        <div className="mt-2 space-y-3">
          {kind === "anthropic" && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={anthropicEnabled}
                onChange={(event) => setAnthropicEnabled(event.target.checked)}
              />
              Anthropic を有効化する (opt-in)
            </label>
          )}
          <label className="block text-sm">
            endpoint
            <input
              aria-label="endpoint"
              className="mt-1 block w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder={DEFAULT_ENDPOINTS[kind]}
            />
          </label>
          <label className="block text-sm">
            model
            <input
              aria-label="model"
              className="mt-1 block w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="model-id"
            />
          </label>
        </div>
      )}

      <div className="mt-4 border-t border-border pt-4">
        <h3 className="text-sm font-semibold">資格情報 (OS ストア)</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {credential === null
            ? "状態を確認してください。値は画面に表示しません。"
            : credential.hasSecret
              ? "保存済み。値は表示しません。"
              : "未保存。"}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={refreshCredential}>状態を確認</Button>
          <Button variant="outline" size="sm" onClick={handleDeleteCredential}>削除</Button>
        </div>
        <div className="mt-2 flex gap-2">
          <input
            aria-label="資格情報の入力"
            type="password"
            autoComplete="off"
            className="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm"
            value={secretInput}
            onChange={(event) => setSecretInput(event.target.value)}
            placeholder="API キーなど"
          />
          <Button size="sm" onClick={handleSaveCredential} disabled={secretInput.length === 0}>保存</Button>
        </div>
        {credentialMessage && <p className="mt-2 text-xs text-muted-foreground">{credentialMessage}</p>}
      </div>

      <div className="mt-4 border-t border-border pt-4">
        <h3 className="text-sm font-semibold">接続テスト</h3>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => handleTest(false)} disabled={testBusy}>
            設定を確認
          </Button>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={liveConfirm}
              onChange={(event) => setLiveConfirm(event.target.checked)}
            />
            実際に接続する
          </label>
          <Button variant="outline" size="sm" onClick={() => handleTest(true)} disabled={testBusy || !liveConfirm}>
            接続テスト
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          接続テストは最小限の要求のみ送ります。Anthropic は max_tokens: 1 の呼び出しを含みます。
        </p>
        {testResult && (
          <p role="status" className="mt-2 text-sm font-medium">
            {testResult.ok ? "成功" : "失敗"}: {testResult.detail}
          </p>
        )}
      </div>

      <div className="mt-4 border-t border-border pt-4">
        <h3 className="text-sm font-semibold">送信対象 (正確な範囲)</h3>
        {contexts.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">送信対象がありません。</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {contexts.map((context) => (
              <li key={context.documentId} className="flex items-center justify-between gap-2 text-xs">
                <span className="font-mono">{summarizeContext(context)}</span>
                {onRemoveContext && (
                  <Button variant="outline" size="sm" onClick={() => onRemoveContext(context.documentId)}>
                    外す
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          作業コピー: {staging ? <span className="font-mono">{staging.copyId}</span> : "未解決 (#8 連携後に利用可)"}
        </p>
      </div>

      <div className="mt-4 border-t border-border pt-4">
        <h3 className="text-sm font-semibold">プロンプト</h3>
        <div className="mt-2" role="group" aria-label="プロンプトの種類">
          {MODE_ORDER.map((candidate) => (
            <label key={candidate} className="mr-4 inline-flex items-center gap-1 text-sm">
              <input
                type="radio"
                name="ai-prompt-mode"
                checked={mode === candidate}
                onChange={() => setMode(candidate)}
              />
              {MODE_LABELS[candidate]}
            </label>
          ))}
        </div>
        <textarea
          aria-label="プロンプト"
          className="mt-2 block w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
          rows={4}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="AI への指示を書きます"
        />
        <div className="mt-2 flex gap-2">
          <Button onClick={handleSend} disabled={!canSend}>
            {running ? "送信中…" : "送信"}
          </Button>
          {running && <Button variant="outline" onClick={handleCancel}>取り消し</Button>}
        </div>
        {anthropicBlocked && (
          <p className="mt-1 text-xs text-muted-foreground">Anthropic を有効化すると送信できます。</p>
        )}
      </div>

      <div className="mt-4 border-t border-border pt-4" aria-live="polite">
        <h3 className="text-sm font-semibold">応答</h3>
        {output && <p className="mt-2 whitespace-pre-wrap text-sm">{output}</p>}
        {cancelled && <p className="mt-2 text-sm">取り消しました。</p>}
        {streamError && (
          <p role="alert" className="mt-2 text-sm font-medium text-red-600">
            {describeAiError(streamError)}
          </p>
        )}
        {proposal && (
          <div className="mt-2 rounded-lg border border-border p-3">
            <p className="text-xs font-semibold text-muted-foreground">提案 (原文は変更しません)</p>
            <p className="mt-1 whitespace-pre-wrap text-sm">{proposal.text}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              基準: {proposal.baseContexts.map((ref) => `${ref.documentId} rev ${ref.revision}`).join(", ")}
            </p>
          </div>
        )}
        {sent.length > 0 && (
          <div className="mt-2">
            <p className="text-xs font-semibold text-muted-foreground">送信済みの範囲</p>
            <ul className="mt-1 space-y-1">
              {sent.map((summary) => (
                <li key={summary.documentId} className="font-mono text-xs">
                  {summary.documentId} rev {summary.revision}{" "}
                  {summary.ranges.map((range) => `[${range.start}, ${range.end})`).join(", ")} {summary.chars}文字
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
