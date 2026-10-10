// Shared Agent/inline run lifecycle hook (presentation).
//
// React fencing around the application run core: run token, cancel request,
// settled guard, owned stop handle, and busy ownership. Early IPC events stay
// buffered in the transport; stale or settled handles never touch UI, a late
// `startPrompt` resolution never leaks a spinner, and unmount always cancels
// the owned run. Agent owns conversations/history; inline owns fixed rewrite.

import { useCallback, useEffect, useRef, useState } from "react";
import { cancelPromptSafe } from "../../application/ai/ai-run-core";
import type { AiRun } from "../../application/ai/ai-run-core";

/**
 * Create a fenced run handle for one chat, broadcasting busy ownership.
 *
 * `onBusyChange` notifies the shell's shared staging fence so the other chat
 * stays disabled while this chat owns the single staging slot.
 */
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

  /** Broadcast busy ownership, dropping stale releases for foreign tokens. */
  const setBusy = useCallback((next: boolean, token = runTokenRef.current) => {
    if (!next && token !== ownedTokenRef.current) return;
    if (next) ownedTokenRef.current = token;
    if (busyRef.current === next) return;
    busyRef.current = next;
    setOwnedBusy(next);
    onBusyChangeRef.current?.(next);
  }, []);

  /** Allocate the next run token and clear cancel/settled guards. */
  const beginRun = useCallback(() => {
    const token = runTokenRef.current + 1;
    runTokenRef.current = token;
    cancelRequestedRef.current = false;
    settledTokenRef.current = -1;
    return token;
  }, []);

  /** Fence the previous run and cancel its owned stop without touching state. */
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

  /** Request cancellation and stop the owned run when one exists. */
  const cancelOwned = useCallback(async () => {
    cancelRequestedRef.current = true;
    const stop = stopRef.current;
    if (stop) await cancelPromptSafe(stop);
  }, []);

  return {
    beginRun,
    /** Check whether the token is the current run. */
    isCurrent: (token: number) => token === runTokenRef.current,
    /** Check whether the token already settled. */
    isSettled: (token: number) => settledTokenRef.current === token,
    /** Mark the token settled so late handles cancel. */
    markSettled: (token: number) => {
      settledTokenRef.current = token;
    },
    /** Whether cancellation was requested for the current run. */
    isCancelRequested: () => cancelRequestedRef.current,
    /** Store the owned stop handle for the current run. */
    setStop: (stop: (() => Promise<void>) | null) => {
      stopRef.current = stop;
    },
    /** Take and clear the owned stop handle. */
    takeStop: () => {
      const stop = stopRef.current;
      stopRef.current = null;
      return stop;
    },
    setBusy,
    fence,
    cancelOwned,
    /** Owned busy flag for spinners gated on this chat's own run. */
    get ownedBusy() {
      return busyRef.current;
    },
  };
}
