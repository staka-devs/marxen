import type { LabelKey } from "../contracts/localization";
import type { FrontendAiError, Translator } from "../contracts/localization";
import { japaneseTranslator } from "./localization";
import { renderLocalizedText } from "./localization";
import { LocalizableError } from "./localized-error";
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
export const AI_CONTRACT_VERSION = 7;

/** Japanese labels for provider kinds shown in settings. */
export const KIND_LABELS: Record<AiProviderKind, string> = {
  acp: "ACP エージェント",
  openai_chat_completions: "OpenAI Chat Completions",
  openai_responses: "OpenAI Responses",
  anthropic: "Anthropic",
};

/** Japanese labels for ACP presets. */
export const PRESET_LABELS: Record<AcpPreset, string> = {
  codex: "Codex",
  opencode: "OpenCode",
  copilot: "GitHub Copilot",
  claude_code: "Claude Code",
  devin: "Devin",
  custom: "カスタム",
};

/** Japanese labels for prompt modes. */
export const MODE_LABELS: Record<PromptMode, string> = {
  ask: "相談",
  generate: "執筆",
  rewrite: "推敲",
  workspace: "文書編集",
};

/** Default endpoints per provider kind (ACP has none). */
export const DEFAULT_ENDPOINTS: Record<AiProviderKind, string> = {
  acp: "",
  openai_chat_completions: "https://api.openai.com/v1",
  openai_responses: "https://api.openai.com/v1",
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
  if (kind === "openai_chat_completions" || kind === "openai_responses") {
    return {
      kind,
      acp: null,
      openai: { endpoint: DEFAULT_ENDPOINTS.openai_chat_completions, model: "" },
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
  if (state.kind === "openai_chat_completions" || state.kind === "openai_responses") {
    return {
      kind: state.kind,
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
export function summarizeContext(context: PromptContext, t: Translator = japaneseTranslator): string {
  const chars = [...context.text].length;
  return t("{{value0}} rev {{value1}} {{value2}} {{value3}}文字", { value0: (context.documentId), value1: (context.revision), value2: (formatRanges(context)), value3: (chars) });
}

/**
 * Describe an AI error using the supplied locale, defaulting to standard Japanese.
 *
 * Every wire code maps to an actionable message; unknown shapes fall back to
 * their detail text instead of leaking `undefined`.
 */
export function describeAiError(error: AiError, t: Translator = japaneseTranslator): string {
  if ("frontendMessage" in error) return renderLocalizedText((error as FrontendAiError).frontendMessage, t);
  switch (error.code) {
    case "invalid_config":
      return t("設定が正しくありません: {{value0}}", { value0: (error.detail) });
    case "missing_credentials":
      return t("{{value0}} の資格情報が OS ストアにありません。", { value0: (t(KIND_LABELS[error.provider] as LabelKey)) });
    case "missing_binary":
      return t("{{value0}} が見つかりません。CLI をインストールして PATH を通してください。", { value0: (error.command) });
    case "spawn_failed":
      return t("エージェントを起動できません: {{value0}}", { value0: (error.detail) });
    case "connection_failed":
      return t("接続できません: {{value0}}", { value0: (error.detail) });
    case "auth_failed":
      return t("認証に失敗しました: {{value0}}", { value0: (error.detail) });
    case "stream_failed":
      return t("応答の受信に失敗しました: {{value0}}", { value0: (error.detail) });
    case "request_cancelled":
      return t("取り消しました。");
    case "session_required":
      return t("セッションが必要です。");
    case "session_busy":
      return t("実行中のため、新しい送信はできません。");
    case "unknown_session":
      return t("この接続は再開できません。新しい会話を開始してください。");
    case "staging_unresolved":
      return t("作業コピーを準備できません。文書を開いて対象範囲を指定してください。");
    case "live_target_rejected":
      return t("Markdownファイルは直接指定できません: {{value0}}", { value0: (error.detail) });
    case "unsupported_protocol":
      return t("protocol version {{value0}} には未対応です。接続を閉じました。", { value0: (error.version) });
    case "claude_code_refused":
      return t("{{value0}} は起動しません。Codex / OpenCode / カスタムを使います。", { value0: (error.command) });
    case "credential_store_failed":
      return t("資格情報ストアの操作に失敗しました: {{value0}}", { value0: (error.detail) });
    default: {
      const failure = error as { detail?: unknown };
      return typeof failure.detail === "string" ? failure.detail : JSON.stringify(error) || t("処理に失敗しました。");
    }
  }
}

/**
 * Describe an invoke failure that may or may not be a wire `AiError`.
 *
 * Passes wire errors to {@link describeAiError}; transport `Error`s keep
 * their message so browser-side failures stay readable.
 */
export function describeInvokeError(cause: unknown, t: Translator = japaneseTranslator): string {
  if (cause instanceof LocalizableError) return renderLocalizedText(cause.localized, t);
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    return describeAiError(cause as AiError, t);
  }
  return cause instanceof Error ? cause.message : String(cause);
}
