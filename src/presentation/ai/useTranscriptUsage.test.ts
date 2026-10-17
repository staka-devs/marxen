import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { TranscriptUsageGateway } from "../../application/ai/usage-ports";
import type { TranscriptUsageReport } from "../../contracts/ai-contracts";
import { useTranscriptUsage } from "./useTranscriptUsage";

/** Report one fixture transcript agent without touching native stores. */
function fixtureReport(): TranscriptUsageReport {
  return {
    agents: [{ agent: "codex", sessions: [], truncated: false, reason: "store_missing", scannedFiles: 0 }],
    receivedMs: 3,
  };
}

it("keeps the latest refresh when an earlier scan returns later", async () => {
  const finish: ((report: TranscriptUsageReport) => void)[] = [];
  const gateway: TranscriptUsageGateway = {
    /** Capture independent scan requests to exercise response ordering. */
    read: vi.fn(() => new Promise<TranscriptUsageReport>((resolve) => { finish.push(resolve); })),
  };
  const { result } = renderHook(() => useTranscriptUsage(gateway));
  let refresh: Promise<void> | undefined;
  act(() => { refresh = result.current.refresh(); });
  await act(async () => { finish[1]({ ...fixtureReport(), receivedMs: 2 }); await refresh; });
  await act(async () => finish[0]({ ...fixtureReport(), receivedMs: 1 }));
  expect(result.current.report?.receivedMs).toBe(2);
  expect(result.current.loading).toBe(false);
  expect(gateway.read).toHaveBeenCalledTimes(2);
});

it("distinguishes an empty report from a failed scan", async () => {
  const gateway: TranscriptUsageGateway = {
    /** Fail once, then report measured agents. */
    read: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(fixtureReport()),
  };
  const { result } = renderHook(() => useTranscriptUsage(gateway));
  await waitFor(() => expect(result.current.failed).toBe(true));
  expect(result.current.report).toBeUndefined();
  await act(async () => result.current.refresh());
  expect(result.current.failed).toBe(false);
  expect(result.current.report).toEqual(fixtureReport());
});

it("keeps transcript support optional instead of simulating a browser scan", async () => {
  const { result } = renderHook(() => useTranscriptUsage());
  await act(async () => result.current.refresh());
  expect(result.current.report).toBeUndefined();
  expect(result.current.failed).toBe(false);
  expect(result.current.loading).toBe(false);
});
