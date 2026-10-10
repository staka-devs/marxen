// Shared Agent/inline run lifecycle (Issue #14).
//
// `AiPanel` (multi-turn Agent chat) and `InlineChat` (single-shot rewrite)
// previously carried line-for-line copies of the same fencing skeleton:
// run token, cancel request, settled guard, owned stop handle, and busy
// ownership. Behavior-critical ordering lives here so both chats keep it:
// early IPC events stay buffered in `lib/ai` (`startPrompt`), stale or
// settled handles never touch UI, a late `startPrompt` resolution never
// leaks a spinner, and unmount always cancels the owned run.
//
// Intentional divergence stays in the components: Agent owns conversations,
// history payloads, and multi-mode sends; inline owns fixed `rewrite` mode,
// empty history, cursor-anchored positioning, and its review button. The
// shared staging slot stays owned by the shell (`disabled` + `ensureStaging`).

import { useCallback, useEffect, useRef, useState } from "react";
import { cancelPromptSafe, describeInvokeError, isClaudeCommand } from "./ai";
import type { AiError, AiProviderConfig } from "../shared/ai-contracts";

export function normalizeAiError(cause: unknown): AiError {
  return typeof cause === "object" && cause !== null && "code" in cause
    ? (cause as AiError)
    : { code: "connection_failed", detail: describeInvokeError(cause) };
}

/** Mirror of the Rust refusal: Claude Code is never launched from any chat. */
export function claudeRefusalError(command: string): AiError {
  return { code: "claude_code_refused", command: command.trim() };
}

export function isClaudeBlockedProvider(provider: AiProviderConfig): string | null {
  if (provider.kind === "acp" && provider.acp?.preset === "custom" && isClaudeCommand(provider.acp.argv?.command ?? "")) {
    return provider.acp.argv?.command ?? "";
  }
  return null;
}

export interface AiRun {
  /** Allocate the next run token and clear cancel/settled guards. */
  beginRun(): number;
  isCurrent(token: number): boolean;
  isSettled(token: number): boolean;
  markSettled(token: number): void;
  isCancelRequested(): boolean;
  setStop(stop: (() => Promise<void>) | null): void;
  takeStop(): (() => Promise<void>) | null;
  /** Broadcast busy ownership; stale `false` for a foreign token is dropped. */
  setBusy(next: boolean, token?: number): void;
  /** Fence the previous run and cancel its owned stop; component state settles itself. */
  fence(): void;
  /** Request cancellation and stop the owned run when one exists. */
  cancelOwned(): Promise<void>;
  /** Owned busy flag for spinners gated on this chat's own run. */
  readonly ownedBusy: boolean;
}

export function useAiRun(onBusyChange?: (busy: boolean) => void): AiRun {
  const runTokenRef = useRef(0);
  const cancelRequestedRef = useRef(false);
  const settledTokenRef = useRef(-1);
  const stopRef = useRef<(() => Promise<void>) | null>(null);
  const busyRef = useRef(false);
  const ownedTokenRef = useRef(-1);
  const [, setOwnedBusy] = useState(false);
  const onBusyChangeRef = useRef(onBusyChange);
  onBusyChangeRef.current = onBusyChange;

  // Unmount cleanup cancels the owned run so late callbacks settle fenced.
  useEffect(() => {
    return () => {
      runTokenRef.current += 1;
      const stop = stopRef.current;
      stopRef.current = null;
      if (stop) void cancelPromptSafe(stop).finally(() => onBusyChangeRef.current?.(false));
    };
  }, []);

  const setBusy = useCallback((next: boolean, token = runTokenRef.current) => {
    if (!next && token !== ownedTokenRef.current) return;
    if (next) ownedTokenRef.current = token;
    if (busyRef.current === next) return;
    busyRef.current = next;
    setOwnedBusy(next);
    onBusyChangeRef.current?.(next);
  }, []);

  const beginRun = useCallback(() => {
    const token = runTokenRef.current + 1;
    runTokenRef.current = token;
    cancelRequestedRef.current = false;
    settledTokenRef.current = -1;
    return token;
  }, []);

  const fence = useCallback(() => {
    const ownedToken = ownedTokenRef.current;
    runTokenRef.current += 1;
    cancelRequestedRef.current = false;
    const stop = stopRef.current;
    stopRef.current = null;
    if (stop) void cancelPromptSafe(stop).finally(() => {
      if (ownedToken !== ownedTokenRef.current) return;
      if (!busyRef.current) return;
      busyRef.current = false;
      setOwnedBusy(false);
      onBusyChangeRef.current?.(false);
    });
  }, []);

  const cancelOwned = useCallback(async () => {
    cancelRequestedRef.current = true;
    const stop = stopRef.current;
    if (stop) await cancelPromptSafe(stop);
  }, []);

  return {
    beginRun,
    isCurrent: (token: number) => token === runTokenRef.current,
    isSettled: (token: number) => settledTokenRef.current === token,
    markSettled: (token: number) => {
      settledTokenRef.current = token;
    },
    isCancelRequested: () => cancelRequestedRef.current,
    setStop: (stop: (() => Promise<void>) | null) => {
      stopRef.current = stop;
    },
    takeStop: () => {
      const stop = stopRef.current;
      stopRef.current = null;
      return stop;
    },
    setBusy,
    fence,
    cancelOwned,
    get ownedBusy() {
      return busyRef.current;
    },
  };
}

/**
 * Settle a just-returned `startPrompt` session: when the run already went
 * stale, settled, or was cancelled while starting, cancel the late handle
 * so no spinner leaks. Returns true when the caller may keep the handle.
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
