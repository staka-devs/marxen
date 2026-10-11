// Deterministic AI provider configuration (domain).
//
// Pure labels, defaults, builders, and error text. No Tauri, DOM, React, or
// browser globals: the native side owns credentials, spawning, and streams.

import type {
  AcpPreset,
  AiError,
  AiProviderConfig,
  AiProviderKind,
  PromptContext,
  PromptMode,
} from "../contracts/ai-contracts";

/** IPC stream event name shared by the client and tests. */
export const AI_STREAM_EVENT = "ai-stream";

/** AI IPC schema version mirrored from the Rust side. */
export const AI_CONTRACT_VERSION = 3;

/** Japanese labels for provider kinds shown in settings. */
export const KIND_LABELS: Record<AiProviderKind, string> = {
  acp: "ACP エージェント",
  openai_compatible: "OpenAI 互換",
  anthropic: "Anthropic",
};

/** Japanese labels for ACP presets. */
export const PRESET_LABELS: Record<AcpPreset, string> = {
  codex: "Codex",
  opencode: "OpenCode",
  copilot: "GitHub Copilot",
  custom: "カスタム",
};

/** Japanese labels for prompt modes. */
export const MODE_LABELS: Record<PromptMode, string> = {
  ask: "質問",
  generate: "生成",
  rewrite: "選択書き換え",
  workspace: "ワークスペース編集",
};

/** Default endpoints per provider kind (ACP has none). */
export const DEFAULT_ENDPOINTS: Record<AiProviderKind, string> = {
  acp: "",
  openai_compatible: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
};

/**
 * Mirror of the Rust refusal: detect Claude Code commands by basename.
 *
 * Matches `claude` / `claude-code` with optional `.exe` and directories, so
 * the shell can refuse before any spawn without inventing a second rule.
 */
export function isClaudeCommand(command: string): boolean {
  const base = command.split(/[/\\]/).pop() ?? command;
  const stem = base.replace(/\.exe$/i, "").toLowerCase();
  return stem === "claude" || stem === "claude-code";
}

/**
 * Build a kind-matched provider config with an opt-in Anthropic section.
 *
 * Returns null sections for inactive kinds so the Rust validator sees exactly
 * one active backend.
 */
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

/** UI form state for building a provider config. */
export interface ProviderConfigState {
  kind: AiProviderKind;
  preset: AcpPreset;
  command: string;
  argsText: string;
  endpoint: string;
  model: string;
  anthropicEnabled: boolean;
  acpSelections?: import("../contracts/ai-contracts").AcpSelection[];
}

/**
 * Build a wire provider config from settings form state.
 *
 * Custom ACP splits newline-separated args and trims blanks; endpoints and
 * model names are trimmed so pasted values do not fail validation.
 */
export function buildProviderConfig(state: ProviderConfigState): AiProviderConfig {
  if (state.kind === "acp") {
    if (state.preset === "custom") {
      const args = state.argsText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      return {
        kind: "acp",
        acp: { preset: "custom", argv: { command: state.command.trim(), args }, ...(state.acpSelections?.length ? { selections: state.acpSelections } : {}) },
        openai: null,
        anthropic: null,
      };
    }
    return { kind: "acp", acp: { preset: state.preset, argv: null, ...(state.acpSelections?.length ? { selections: state.acpSelections } : {}) }, openai: null, anthropic: null };
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

/**
 * Format context ranges as `[start, end)` pairs for display.
 *
 * Joins multiple ranges so the exact sent scope stays visible in one line.
 */
export function formatRanges(context: PromptContext): string {
  return context.ranges.map((range) => `[${range.start}, ${range.end})`).join(", ");
}

/**
 * Summarize exactly what will be sent for one context in one line.
 *
 * Includes document ID, revision, ranges, and Unicode character count so
 * review surfaces never show internal IDs alone.
 */
export function summarizeContext(context: PromptContext): string {
  const chars = [...context.text].length;
  return `${context.documentId} rev ${context.revision} ${formatRanges(context)} ${chars}文字`;
}

/**
 * Describe an AI error in Japanese for notices and chat states.
 *
 * Every wire code maps to an actionable message; unknown shapes fall back to
 * their detail text instead of leaking `undefined`.
 */
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
      return "この接続は再開できません。新しい会話を開始してください。";
    case "staging_unresolved":
      return "作業コピーを準備できません。文書を開いて対象範囲を指定してください。";
    case "live_target_rejected":
      return `Markdownファイルは直接指定できません: ${error.detail}`;
    case "unsupported_protocol":
      return `protocol version ${error.version} には未対応です。接続を閉じました。`;
    case "claude_code_refused":
      return `${error.command} は起動しません。Codex / OpenCode / カスタムを使います。`;
    case "credential_store_failed":
      return `資格情報ストアの操作に失敗しました: ${error.detail}`;
    default: {
      const failure = error as { detail?: unknown };
      return typeof failure.detail === "string" ? failure.detail : "処理に失敗しました。";
    }
  }
}

/**
 * Describe an invoke failure that may or may not be a wire `AiError`.
 *
 * Passes wire errors to {@link describeAiError}; transport `Error`s keep
 * their message so browser-side failures stay readable.
 */
export function describeInvokeError(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    return describeAiError(cause as AiError);
  }
  return cause instanceof Error ? cause.message : String(cause);
}
