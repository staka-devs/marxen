import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { AiUsageGateway } from "../../application/ai/usage-ports";
import type { ReportedUsage } from "../../contracts/ai-contracts";
import { useAiUsage } from "./useAiUsage";

/** Construct an observation for testing transport ordering. */
function report(used: number, receivedMs: number): ReportedUsage {
  return { provider: "acp", preset: "codex", runId: "run", sessionId: "session", source: "usage_update", scope: "session", used, size: 100, receivedMs };
}

it("preserves events received while an older snapshot is pending", async () => {
  let observe: ((usage: ReportedUsage) => void) | undefined;
  let finish: ((snapshot: ReportedUsage[]) => void) | undefined;
  const snapshot = new Promise<ReportedUsage[]>((resolve) => { finish = resolve; });
  const cleanup = vi.fn();
  const gateway: AiUsageGateway = {
    /** Return the captured pending snapshot. */
    snapshot: vi.fn(() => snapshot),
    /** Capture the native observation callback. */
    subscribe: vi.fn(async (onUsage) => { observe = onUsage; return cleanup; }),
  };
  const { result, unmount } = renderHook(() => useAiUsage(gateway));
  act(() => observe?.(report(30, 3)));
  await act(async () => finish?.([report(10, 1)]));
  expect(result.current.agents[0].context?.used).toBe(30);
  expect(result.current.loading).toBe(false);
  expect(gateway.snapshot).toHaveBeenCalledOnce();
  unmount();
  expect(cleanup).toHaveBeenCalledOnce();
});

it("cleans up a listener whose registration completes after unmount", async () => {
  let finish: ((cleanup: () => void) => void) | undefined;
  const subscription = new Promise<() => void>((resolve) => { finish = resolve; });
  const cleanup = vi.fn();
  const gateway: AiUsageGateway = {
    /** Return an empty retained snapshot. */
    snapshot: vi.fn(async () => []),
    /** Hold listener registration until after unmount. */
    subscribe: vi.fn(() => subscription),
  };
  const { unmount } = renderHook(() => useAiUsage(gateway));
  unmount();
  await act(async () => finish?.(cleanup));
  expect(cleanup).toHaveBeenCalledOnce();
});

it("shows a read failure and recovers without discarding recorded observations", async () => {
  const gateway: AiUsageGateway = {
    /** Fail once, then return a real zero-valued report. */
    snapshot: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue([report(0, 1)]),
    /** Return a listener cleanup without starting inference. */
    subscribe: vi.fn(async () => vi.fn()),
  };
  const { result } = renderHook(() => useAiUsage(gateway));
  await waitFor(() => expect(result.current.failed).toBe(true));
  await act(async () => result.current.refresh());
  expect(result.current.failed).toBe(false);
  expect(result.current.agents[0].context?.used).toBe(0);
});

it("does not hide a failed live subscription when retained observations load successfully", async () => {
  let finish: ((snapshot: ReportedUsage[]) => void) | undefined;
  const snapshot = new Promise<ReportedUsage[]>((resolve) => { finish = resolve; });
  const gateway: AiUsageGateway = {
    /** Delay the retained observation until after listener registration fails. */
    snapshot: vi.fn(() => snapshot),
    /** Report that live usage cannot be observed. */
    subscribe: vi.fn(async () => { throw new Error("listener unavailable"); }),
  };
  const { result } = renderHook(() => useAiUsage(gateway));
  await waitFor(() => expect(result.current.failed).toBe(true));
  await act(async () => finish?.([report(25, 1)]));
  expect(result.current.agents[0].context?.used).toBe(25);
  expect(result.current.failed).toBe(true);
  expect(result.current.loading).toBe(false);
});
