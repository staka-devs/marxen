import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  claudeRefusalError,
  isClaudeBlockedProvider,
  keepStartedSession,
  normalizeAiError,
  type AiRun,
} from "../../application/ai/ai-run-core";
import { useAiRun } from "./use-ai-run";
import { defaultProviderConfig } from "../../domain/ai-config";

/** Fake fenced run for settling late-handle tests. */ function fakeRun(overrides: Partial<AiRun> = {}): AiRun {
  return {
    beginRun: () => 2,
    isCurrent: (token: number) => token === 1,
    isSettled: () => false,
    markSettled: () => undefined,
    isCancelRequested: () => false,
    setStop: () => undefined,
    takeStop: () => null,
    setBusy: () => undefined,
    fence: () => undefined,
    cancelOwned: async () => undefined,
    ownedBusy: false,
    ...overrides,
  };
}

describe("shared ai run helpers", () => {
  it("guards a second send synchronously and ignores stale busy releases", () => {
    const onBusyChange = vi.fn();
    const { result } = renderHook(() => useAiRun(onBusyChange));
    act(() => {
      const sendingRun = result.current;
      const oldToken = sendingRun.beginRun();
      sendingRun.setBusy(true, oldToken);
      expect(sendingRun.ownedBusy).toBe(true);
      const nextToken = sendingRun.beginRun();
      sendingRun.setBusy(true, nextToken);
      sendingRun.setBusy(false, oldToken);
      expect(sendingRun.ownedBusy).toBe(true);
      sendingRun.setBusy(false, nextToken);
      expect(sendingRun.ownedBusy).toBe(false);
    });
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  });

  it("normalizes unknown failures to connection errors without losing AiError codes", () => {
    expect(normalizeAiError({ code: "session_busy" })).toEqual({ code: "session_busy" });
    expect(normalizeAiError(new Error("boom"))).toEqual({ code: "connection_failed", detail: "boom" });
  });

  it("refuses only claude commands like the Rust validator", () => {
    const custom = {
      ...defaultProviderConfig("acp"),
      acp: { preset: "custom" as const, argv: { command: "claude", args: [] } },
    };
    expect(isClaudeBlockedProvider(custom)).toBe("claude");
    expect(claudeRefusalError("claude ")).toEqual({ code: "claude_code_refused", command: "claude" });
    expect(isClaudeBlockedProvider(defaultProviderConfig("acp"))).toBeNull();
  });

  it("keeps a fresh start and cancels a stale or cancelled late handle", async () => {
    const stop = vi.fn(async () => undefined);
    const setBusy = vi.fn();
    const kept = await keepStartedSession(
      fakeRun({ setStop: () => undefined, setBusy: setBusy as AiRun["setBusy"] }),
      1,
      stop,
    );
    expect(kept).toBe(true);
    expect(stop).not.toHaveBeenCalled();

    const staleBusy = vi.fn();
    const stale = await keepStartedSession(
      fakeRun({ isCurrent: () => false, setBusy: staleBusy as AiRun["setBusy"] }),
      1,
      stop,
    );
    expect(stale).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(staleBusy).toHaveBeenCalledWith(false, 1);

    const cancelledBusy = vi.fn();
    const cancelled = await keepStartedSession(
      fakeRun({ isCancelRequested: () => true, setBusy: cancelledBusy as AiRun["setBusy"] }),
      1,
      stop,
    );
    expect(cancelled).toBe(false);
    expect(stop).toHaveBeenCalledTimes(2);
  });
});

