// Generated from src-tauri/src/contracts/ai.rs. Run npm run ai-contracts:generate.
// Do not edit by hand. AI IPC schema version 7.
import type { DocumentId, Revision, Utf16Range, DocumentLocation } from "./contracts";
export type AiProviderKind = "acp" | "openai_chat_completions" | "openai_responses" | "anthropic";
export type AcpPreset = "codex" | "opencode" | "copilot" | "claude_code" | "custom";
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
export type ApiConnectionId = string;
export type ApiProtocol = "openai_chat_completions" | "openai_responses" | "anthropic";
export type ApiConnection = { id: ApiConnectionId, name: string, protocol: ApiProtocol, endpoint: string, model: string, };
export type AiProviderConfig = { kind: AiProviderKind, acp: AcpConfig | null, openai: OpenAiConfig | null, anthropic: AnthropicConfig | null, 
/**
 * Stable named-connection reference. Present exactly when this config was
 * built from a registered API connection; absent for ACP and legacy
 * single-profile providers, which keep resolving kind credential slots.
 */
connectionId?: ApiConnectionId, };
export type PromptMode = "ask" | "generate" | "rewrite" | "workspace";
export type PromptContext = { location?: DocumentLocation, documentId: DocumentId, revision: Revision, ranges: Array<Utf16Range>, text: string, };
export type IsolatedCopyId = string;
export type AcpSessionId = string;
export type AiRunId = string;
export type StagingTarget = { copyId: IsolatedCopyId, };
export type ChatRole = "user" | "assistant";
export type ChatHistoryMessage = { role: ChatRole, text: string, };
export type AiPromptRequest = { provider: AiProviderConfig, mode: PromptMode, prompt: string, contexts: Array<PromptContext>, staging: StagingTarget, 
/**
 * Unproven resume handles are rejected before provider launch.
 */
sessionId: AcpSessionId | null, 
/**
 * Explicit multi-turn history (oldest first). Only completed turns;
 * bounded and validated by Rust before any side effect.
 */
history: Array<ChatHistoryMessage>, conversationId?: string, };
export type ContextRef = { documentId: DocumentId, revision: Revision, };
export type ProposalText = { text: string, baseContexts: Array<ContextRef>, };
export type ContextSummary = { documentId: DocumentId, revision: Revision, ranges: Array<Utf16Range>, chars: number, };
export type StreamStarted = { runId: AiRunId, };
export type StreamChunk = { runId: AiRunId, text: string, };
export type StreamUsage = { runId: AiRunId, usage: ReportedUsage, };
export type AcpToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
export type AcpToolStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";
export type ToolCallLocation = { path: string, line?: number, };
export type ToolCallContent = { "type": "content", text: string, } | { "type": "diff", path: string, old_text: string | null, new_text: string, };
export type AcpToolCall = { toolCallId: string, title: string, kind: AcpToolKind, status: AcpToolStatus, content?: Array<ToolCallContent>, locations?: Array<ToolCallLocation>, };
export type AcpToolCallUpdate = { toolCallId: string, title?: string, kind?: AcpToolKind, status?: AcpToolStatus, content?: Array<ToolCallContent>, locations?: Array<ToolCallLocation>, };
export type PlanEntryPriority = "high" | "medium" | "low";
export type PlanEntryStatus = "pending" | "in_progress" | "completed";
export type PlanEntry = { content: string, priority: PlanEntryPriority, status: PlanEntryStatus, };
export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";
export type PermissionOption = { optionId: string, name: string, kind: PermissionOptionKind, };
export type StreamToolCall = { runId: AiRunId, toolCall: AcpToolCall, };
export type StreamToolCallUpdate = { runId: AiRunId, update: AcpToolCallUpdate, };
export type StreamPlan = { runId: AiRunId, entries: Array<PlanEntry>, };
export type StreamPermission = { runId: AiRunId, requestId: string, sessionId: AcpSessionId, toolCallId?: string, title: string, options: Array<PermissionOption>, };
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
used?: number, 
/**
 * Total context window size in tokens (`usage_update.size`).
 */
size?: number, 
/**
 * Reported input tokens (`PromptResponse.usage.inputTokens`).
 */
inputTokens?: number, 
/**
 * Reported output tokens (`PromptResponse.usage.outputTokens`).
 */
outputTokens?: number, 
/**
 * Reported total tokens (`PromptResponse.usage.totalTokens`).
 */
totalTokens?: number, 
/**
 * Reported cache-read tokens (`PromptResponse.usage.cachedReadTokens`).
 */
cachedReadTokens?: number, 
/**
 * Reported cache-write tokens (`PromptResponse.usage.cachedWriteTokens`).
 */
cachedWriteTokens?: number, 
/**
 * Reported reasoning tokens (official `thoughtTokens`).
 */
reasoningTokens?: number, 
/**
 * Cumulative session cost exactly as reported in `usage_update.cost`.
 */
cost?: UsageCost, 
/**
 * Unix milliseconds when Rust received the report.
 */
receivedMs: number, };
export type UsageWindow = { usedPercent: number, windowDurationMins?: number, 
/**
 * Unix seconds reported for the next reset; omitted when unavailable.
 */
resetsAt?: number, };
export type UsageCredits = { hasCredits: boolean, unlimited: boolean, balance?: string, };
export type CodexUsageBucket = { id: string, name?: string, primary?: UsageWindow, secondary?: UsageWindow, credits?: UsageCredits, };
export type CodexAccountUsage = { buckets: Array<CodexUsageBucket>, receivedMs: number, };
export type AiStreamEvent = { "type": "started", "payload": StreamStarted } | { "type": "chunk", "payload": StreamChunk } | { "type": "usage", "payload": StreamUsage } | { "type": "tool_call", "payload": StreamToolCall } | { "type": "tool_call_update", "payload": StreamToolCallUpdate } | { "type": "plan", "payload": StreamPlan } | { "type": "permission", "payload": StreamPermission } | { "type": "done", "payload": StreamDone } | { "type": "error", "payload": StreamError } | { "type": "cancelled", "payload": StreamCancelled };
export type AiError = { "code": "invalid_config", detail: string, } | { "code": "missing_credentials", provider: AiProviderKind, } | { "code": "missing_binary", command: string, } | { "code": "spawn_failed", detail: string, } | { "code": "connection_failed", detail: string, } | { "code": "auth_failed", detail: string, } | { "code": "stream_failed", detail: string, } | { "code": "request_cancelled" } | { "code": "session_required" } | { "code": "session_busy" } | { "code": "unknown_session" } | { "code": "staging_unresolved", copy_id: IsolatedCopyId, } | { "code": "live_target_rejected", detail: string, } | { "code": "unsupported_protocol", version: number, } | { "code": "claude_code_refused", command: string, } | { "code": "credential_store_failed", detail: string, };
export type CredentialRef = { provider: AiProviderKind, hasSecret: boolean, };
export type ConnectionCredentialRef = { connectionId: ApiConnectionId, hasSecret: boolean, };
export type AiTestResult = { 
/**
 * Choices returned by an explicit ACP handshake; absent on local/API checks.
 */
configOptions?: Array<AcpConfigOption>, ok: boolean, detail: string, };
