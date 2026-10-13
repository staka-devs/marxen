import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { CodexAccountUsageGateway } from "../../application/ai/usage-ports";
import type { CodexAccountUsage } from "../../contracts/ai-contracts";
import { useCodexAccountUsage } from "./useCodexAccountUsage";

it("keeps the latest refresh when an earlier account request returns later", async () => {
  const finish: ((usage: CodexAccountUsage) => void)[] = [];
  const gateway: CodexAccountUsageGateway = {
    /** Capture independent metadata requests to exercise response ordering. */
    read: vi.fn(() => new Promise<CodexAccountUsage>((resolve) => { finish.push(resolve); })),
  };
  const { result } = renderHook(() => useCodexAccountUsage(gateway));
  let refresh: Promise<void> | undefined;
  act(() => { refresh = result.current.refresh(); });
  await act(async () => { finish[1]({ buckets: [], receivedMs: 2 }); await refresh; });
  await act(async () => finish[0]({ buckets: [], receivedMs: 1 }));
  expect(result.current.usage?.receivedMs).toBe(2);
  expect(result.current.loading).toBe(false);
  expect(gateway.read).toHaveBeenCalledTimes(2);
});

it("distinguishes reported empty limits from a failed account read", async () => {
  const gateway: CodexAccountUsageGateway = {
    /** Fail once, then report no available quota metadata. */
    read: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ buckets: [], receivedMs: 2 }),
  };
  const { result } = renderHook(() => useCodexAccountUsage(gateway));
  await waitFor(() => expect(result.current.failed).toBe(true));
  expect(result.current.usage).toBeUndefined();
  await act(async () => result.current.refresh());
  expect(result.current.failed).toBe(false);
  expect(result.current.usage).toEqual({ buckets: [], receivedMs: 2 });
});

it("keeps usage support optional instead of simulating a browser account", async () => {
  const { result } = renderHook(() => useCodexAccountUsage());
  await act(async () => result.current.refresh());
  expect(result.current.usage).toBeUndefined();
  expect(result.current.failed).toBe(false);
  expect(result.current.loading).toBe(false);
});
