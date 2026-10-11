// Generated from src-tauri/src/contracts/ai.rs. Run npm run ai-contracts:generate.
// Do not edit by hand. AI IPC schema version 2.
import type { DocumentId, Revision, Utf16Range } from "./contracts";
export type AiProviderKind = "acp" | "openai_compatible" | "anthropic";
export type AcpPreset = "codex" | "opencode" | "custom";
export type AcpArgv = { command: string, args: Array<string>, };
export type AcpConfig = { preset: AcpPreset, 
/**
 * Required exactly when preset is custom.
 */
argv: AcpArgv | null, };
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
export type StreamDone = { runId: AiRunId, proposal: ProposalText, sent: Array<ContextSummary>, };
export type StreamError = { runId: AiRunId | null, error: AiError, };
export type StreamCancelled = { runId: AiRunId, };
export type AiStreamEvent = { "type": "started", "payload": StreamStarted } | { "type": "chunk", "payload": StreamChunk } | { "type": "done", "payload": StreamDone } | { "type": "error", "payload": StreamError } | { "type": "cancelled", "payload": StreamCancelled };
export type AiError = { "code": "invalid_config", detail: string, } | { "code": "missing_credentials", provider: AiProviderKind, } | { "code": "missing_binary", command: string, } | { "code": "spawn_failed", detail: string, } | { "code": "connection_failed", detail: string, } | { "code": "auth_failed", detail: string, } | { "code": "stream_failed", detail: string, } | { "code": "request_cancelled" } | { "code": "session_required" } | { "code": "session_busy" } | { "code": "unknown_session" } | { "code": "staging_unresolved", copy_id: IsolatedCopyId, } | { "code": "live_target_rejected", detail: string, } | { "code": "unsupported_protocol", version: number, } | { "code": "claude_code_refused", command: string, } | { "code": "credential_store_failed", detail: string, };
export type CredentialRef = { provider: AiProviderKind, hasSecret: boolean, };
export type AiTestResult = { ok: boolean, detail: string, };
