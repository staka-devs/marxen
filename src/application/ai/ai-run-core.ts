// Shared AI run fencing core (application).
//
// Pure run tokens, cancel/settled guards, owned stop handles, and busy
// ownership shared by Agent and inline chats. No Tauri, DOM, React, or
// browser globals: the React hook lives in presentation and the transport
// lives in infrastructure.

import { describeInvokeError, isClaudeCommand } from "../../domain/ai-config";
import type { AiError, AiProviderConfig } from "../../contracts/ai-contracts";

/**
 * Normalize any failure to a wire `AiError` without losing codes.
 *
 * Wire errors pass through; unknown shapes become `connection_failed` with
 * the invoke text so chat states stay actionable.
 */
export function normalizeAiError(cause: unknown): AiError {
  return typeof cause === "object" && cause !== null && "code" in cause
    ? (cause as AiError)
    : { code: "connection_failed", detail: describeInvokeError(cause) };
}

/**
 * Build the Claude Code refusal error for a blocked custom command.
 *
 * Mirrors the Rust validator: Claude Code is never launched from any chat.
 */
export function claudeRefusalError(command: string): AiError {
  return { code: "claude_code_refused", command: command.trim() };
}

/**
 * Check whether a provider config would launch Claude Code, returning the command.
 *
 * Returns the blocked command for custom ACP presets, or null when safe.
 */
export function isClaudeBlockedProvider(provider: AiProviderConfig): string | null {
  if (provider.kind === "acp" && provider.acp?.preset === "custom" && isClaudeCommand(provider.acp.argv?.command ?? "")) {
    return provider.acp.argv?.command ?? "";
  }
  return null;
}

/** Fenced run handle shared by Agent and inline chats. */
export interface AiRun {
  /** Allocate the next run token and clear cancel/settled guards. */
  beginRun(): number;
  /** Check whether the token is the current run. */
  isCurrent(token: number): boolean;
  /** Check whether the token already settled. */
  isSettled(token: number): boolean;
  /** Mark the token settled so late handles cancel. */
  markSettled(token: number): void;
  /** Whether cancellation was requested for the current run. */
  isCancelRequested(): boolean;
  /** Store the owned stop handle for the current run. */
  setStop(stop: (() => Promise<void>) | null): void;
  /** Take and clear the owned stop handle. */
  takeStop(): (() => Promise<void>) | null;
  /** Broadcast busy ownership; stale `false` for a foreign token is dropped. */
  setBusy(next: boolean, token?: number): void;
  /** Fence the previous run and cancel its owned stop. */
  fence(): void;
  /** Request cancellation and stop the owned run when one exists. */
  cancelOwned(): Promise<void>;
  /** Owned busy flag for spinners gated on this chat's own run. */
  readonly ownedBusy: boolean;
}

/**
 * Best-effort cancel from UI handlers without surfacing cancel errors.
 *
 * The run already finished or the command is gone when this fails.
 */
export async function cancelPromptSafe(stop: () => Promise<void>): Promise<void> {
  try {
    await stop();
  } catch {
    // The run already finished or the command is gone.
  }
}

/**
 * Settle a just-returned `startPrompt` session against the run fence.
 *
 * When the run already went stale, settled, or was cancelled while starting,
 * cancels the late handle so no spinner leaks. Returns true when the caller
 * may keep the handle.
 */
export async function keepStartedSession(run: AiRun, token: number, stop: () => Promise<void>): Promise<boolean> {
  if (!run.isCurrent(token) || run.isSettled(token) || run.isCancelRequested()) {
    await cancelPromptSafe(stop);
    run.setBusy(false, token);
    return false;
  }
  run.setStop(stop);
  return true;
}
