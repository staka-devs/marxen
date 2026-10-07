import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AcpPreset,
  AiError,
  AiPromptRequest,
  AiProviderConfig,
  AiProviderKind,
  AiRunId,
  AiStreamEvent,
  AiTestResult,
  CredentialRef,
  PromptContext,
  PromptMode,
} from "../shared/ai-contracts";

export const AI_STREAM_EVENT = "ai-stream";
export const AI_CONTRACT_VERSION = 1;

export const KIND_LABELS: Record<AiProviderKind, string> = {
  acp: "ACP エージェント",
  openai_compatible: "OpenAI 互換",
  anthropic: "Anthropic",
};

export const PRESET_LABELS: Record<AcpPreset, string> = {
  codex: "Codex",
  opencode: "OpenCode",
  custom: "カスタム",
};

export const MODE_LABELS: Record<PromptMode, string> = {
  ask: "質問",
  generate: "生成",
  rewrite: "選択書き換え",
  workspace: "workspace 修正",
};

export const DEFAULT_ENDPOINTS: Record<AiProviderKind, string> = {
  acp: "",
  openai_compatible: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
};

export function requireDesktop(): void {
  if (!isTauri()) {
    throw new Error("AI 機能はデスクトップアプリで利用します。ブラウザ表示では使えません。");
  }
}

/** Mirror of the Rust refusal: Claude Code is never launched. */
export function isClaudeCommand(command: string): boolean {
  const base = command.split(/[/\\]/).pop() ?? command;
  const stem = base.replace(/\.exe$/i, "").toLowerCase();
  return stem === "claude" || stem === "claude-code";
}

export function defaultProviderConfig(kind: AiProviderKind): AiProviderConfig {
  if (kind === "acp") {
    return { kind, acp: { preset: "codex", argv: null }, openai: null, anthropic: null };
  }
  if (kind === "openai_compatible") {
    return {
      kind,
      acp: null,
      openai: { endpoint: DEFAULT_ENDPOINTS.openai_compatible, model: "" },
      anthropic: null,
    };
  }
  return {
    kind,
    acp: null,
    openai: null,
    anthropic: { enabled: false, endpoint: DEFAULT_ENDPOINTS.anthropic, model: "" },
  };
}

export function formatRanges(context: PromptContext): string {
  return context.ranges.map((range) => `[${range.start}, ${range.end})`).join(", ");
}

/** One-line summary of exactly what will be sent for one context. */
export function summarizeContext(context: PromptContext): string {
  const chars = [...context.text].length;
  return `${context.documentId} rev ${context.revision} ${formatRanges(context)} ${chars}文字`;
}

export function describeAiError(error: AiError): string {
  switch (error.code) {
    case "invalid_config":
      return `設定が正しくありません: ${error.detail}`;
    case "missing_credentials":
      return `${KIND_LABELS[error.provider]} の資格情報が OS ストアにありません。`;
    case "missing_binary":
      return `${error.command} が見つかりません。CLI をインストールして PATH を通してください。`;
    case "spawn_failed":
      return `エージェントを起動できません: ${error.detail}`;
    case "connection_failed":
      return `接続できません: ${error.detail}`;
    case "auth_failed":
      return `認証に失敗しました: ${error.detail}`;
    case "stream_failed":
      return `応答の受信に失敗しました: ${error.detail}`;
    case "request_cancelled":
      return "取り消しました。";
    case "session_required":
      return "セッションが必要です。";
    case "session_busy":
      return "実行中のため、新しい送信はできません。";
    case "unknown_session":
      return "セッションの再開には未対応です。session_id を外して送信してください。";
    case "staging_unresolved":
      return `作業コピー ${error.copy_id} を解決できません。隔離コピー連携 (#8) の後に利用できます。`;
    case "live_target_rejected":
      return `原文ファイルは直接指定できません: ${error.detail}`;
    case "claude_code_refused":
      return `${error.command} は起動しません。Codex / OpenCode / カスタムを使います。`;
    case "credential_store_failed":
      return `資格情報ストアの操作に失敗しました: ${error.detail}`;
  }
}

export function describeInvokeError(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    return describeAiError(cause as AiError);
  }
  return cause instanceof Error ? cause.message : String(cause);
}

export async function getCredentialState(kind: AiProviderKind): Promise<CredentialRef> {
  requireDesktop();
  return invoke<CredentialRef>("ai_credential_state", { kind });
}

export async function setCredential(kind: AiProviderKind, secret: string): Promise<void> {
  requireDesktop();
  await invoke("ai_set_credential", { kind, secret });
}

export async function deleteCredential(kind: AiProviderKind): Promise<void> {
  requireDesktop();
  await invoke("ai_delete_credential", { kind });
}

export async function testConnection(config: AiProviderConfig, live: boolean): Promise<AiTestResult> {
  requireDesktop();
  return invoke<AiTestResult>("ai_test_connection", { config, live });
}

export interface PromptSession {
  runId: AiRunId;
  stop: () => Promise<void>;
}

/** Best-effort cancel from UI handlers; surfacing cancel errors helps nobody. */
export async function cancelPromptSafe(stop: () => Promise<void>): Promise<void> {
  try {
    await stop();
  } catch {
    // The run already finished or the command is gone.
  }
}

export async function startPrompt(
  request: AiPromptRequest,
  onEvent: (event: AiStreamEvent) => void,
): Promise<PromptSession> {
  requireDesktop();
  let unlisten: UnlistenFn | null = null;
  let runId: AiRunId | null = null;
  let stopped = false;
  unlisten = await listen<AiStreamEvent>(AI_STREAM_EVENT, (event) => {
    const payload = event.payload;
    const eventRunId =
      payload.type === "error" ? (payload.payload.runId ?? runId) : payload.payload.runId;
    if (runId !== null && eventRunId !== runId) {
      return;
    }
    onEvent(payload);
  });
  try {
    runId = await invoke<AiRunId>("ai_prompt_stream", { request });
  } catch (cause) {
    unlisten();
    throw cause;
  }
  const owned = runId;
  return {
    runId: owned,
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      try {
        await invoke("ai_prompt_cancel", { runId: owned });
      } finally {
        unlisten?.();
      }
    },
  };
}
