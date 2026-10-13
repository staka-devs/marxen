// Generated from src-tauri/src/contracts/ai.rs. Run npm run ai-contracts:generate.
// Do not edit by hand. AI IPC schema version 4.
import type { DocumentId, Revision, Utf16Range } from "./contracts";
export type AiProviderKind = "acp" | "openai_compatible" | "anthropic";
export type AcpPreset = "codex" | "opencode" | "copilot" | "custom";
export type AcpArgv = { command: string, args: Array<string>, };
export type AcpConfig = { preset: AcpPreset, 
/**
 * Required exactly when preset is custom.
 */
argv: AcpArgv | null, 
/**
 * Explicit choices advertised by this agent; applied before each prompt.
 */
selections?: Array<AcpSelection>, };
export type AcpSelection = { id: string, value: string, };
export type AcpChoice = { value: string, name: string, };
export type AcpConfigOption = { id: string, name: string, category: string, currentValue: string, options: Array<AcpChoice>, };
export type OpenAiConfig = { endpoint: string, model: string, };
export type AnthropicConfig = { enabled: boolean, endpoint: string, model: string, };
export type AiProviderConfig = { kind: AiProviderKind, acp: AcpConfig | null, openai: OpenAiConfig | null, anthropic: AnthropicConfig | null, };
export type PromptMode = "ask" | "generate" | "rewrite" | "workspace";
export type PromptContext = { documentId: DocumentId, revision: Revision, ranges: Array<Utf16Range>, text: string, };
export type IsolatedCopyId = string;
export type AcpSessionId = string;
export type AiRunId = string;
export type StagingTarget = { copyId: IsolatedCopyId, };
export type ChatRole = "user" | "assistant";
export type ChatHistoryMessage = { role: ChatRole, text: string, };
export type AiPromptRequest = { provider: AiProviderConfig, mode: PromptMode, prompt: string, contexts: Array<PromptContext>, staging: StagingTarget, 
/**
 * Resume an existing ACP session. Required to be absent for HTTP backends.
 */
sessionId: AcpSessionId | null, 
/**
 * Explicit multi-turn history (oldest first). Only completed turns;
 * bounded and validated by Rust before any side effect.
 */
history: Array<ChatHistoryMessage>, };
export type ContextRef = { documentId: DocumentId, revision: Revision, };
export type ProposalText = { text: string, baseContexts: Array<ContextRef>, };
export type ContextSummary = { documentId: DocumentId, revision: Revision, ranges: Array<Utf16Range>, chars: number, };
export type StreamStarted = { runId: AiRunId, };
export type StreamChunk = { runId: AiRunId, text: string, };
export type StreamUsage = { runId: AiRunId, usage: ReportedUsage, };
export type StreamDone = { runId: AiRunId, proposal: ProposalText, sent: Array<ContextSummary>, };
export type StreamError = { runId: AiRunId | null, error: AiError, };
export type StreamCancelled = { runId: AiRunId, };
export type AcpUsageSource = "usage_update" | "prompt_response";
export type AcpUsageScope = "session" | "prompt_response_undefined";
export type UsageCost = { 
/**
 * Decimal amount text from the validated wire number (for example `"12.34"`).
 */
amount: string, 
/**
 * ISO 4217 code as reported (for example `"USD"`).
 */
currency: string, };
export type ReportedUsage = { provider: AiProviderKind, 
/**
 * ACP preset that produced the report, when the provider is ACP.
 */
preset?: AcpPreset, runId: AiRunId, sessionId: AcpSessionId, source: AcpUsageSource, scope: AcpUsageScope, 
/**
 * Tokens currently in context (`usage_update.used`).
 */
used?: bigint, 
/**
 * Total context window size in tokens (`usage_update.size`).
 */
size?: bigint, 
/**
 * Reported input tokens (`PromptResponse.usage.inputTokens`).
 */
inputTokens?: bigint, 
/**
 * Reported output tokens (`PromptResponse.usage.outputTokens`).
 */
outputTokens?: bigint, 
/**
 * Reported total tokens (`PromptResponse.usage.totalTokens`).
 */
totalTokens?: bigint, 
/**
 * Reported cache-read tokens (`PromptResponse.usage.cachedReadTokens`).
 */
cachedReadTokens?: bigint, 
/**
 * Reported cache-write tokens (`PromptResponse.usage.cachedWriteTokens`).
 */
cachedWriteTokens?: bigint, 
/**
 * Reported reasoning tokens (official `thoughtTokens`).
 */
reasoningTokens?: bigint, 
/**
 * Cumulative session cost exactly as reported in `usage_update.cost`.
 */
cost?: UsageCost, 
/**
 * Unix milliseconds when Rust received the report.
 */
receivedMs: bigint, };
export type AiStreamEvent = { "type": "started", "payload": StreamStarted } | { "type": "chunk", "payload": StreamChunk } | { "type": "usage", "payload": StreamUsage } | { "type": "done", "payload": StreamDone } | { "type": "error", "payload": StreamError } | { "type": "cancelled", "payload": StreamCancelled };
export type AiError = { "code": "invalid_config", detail: string, } | { "code": "missing_credentials", provider: AiProviderKind, } | { "code": "missing_binary", command: string, } | { "code": "spawn_failed", detail: string, } | { "code": "connection_failed", detail: string, } | { "code": "auth_failed", detail: string, } | { "code": "stream_failed", detail: string, } | { "code": "request_cancelled" } | { "code": "session_required" } | { "code": "session_busy" } | { "code": "unknown_session" } | { "code": "staging_unresolved", copy_id: IsolatedCopyId, } | { "code": "live_target_rejected", detail: string, } | { "code": "unsupported_protocol", version: number, } | { "code": "claude_code_refused", command: string, } | { "code": "credential_store_failed", detail: string, };
export type CredentialRef = { provider: AiProviderKind, hasSecret: boolean, };
export type AiTestResult = { 
/**
 * Choices returned by an explicit ACP handshake; absent on local/API checks.
 */
configOptions?: Array<AcpConfigOption>, ok: boolean, detail: string, };
