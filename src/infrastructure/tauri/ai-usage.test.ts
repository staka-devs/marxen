import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { aiUsageGateway, codexAccountUsageGateway, transcriptUsageGateway } from "./ai-usage";
import type { AiStreamEvent, ReportedUsage, TranscriptUsageReport } from "../../contracts/ai-contracts";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  /** Run the usage adapter against the mocked desktop transport. */
  isTauri: () => true,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

it("refreshes existing reports without starting a prompt or connection probe", async () => {
  vi.mocked(invoke).mockResolvedValue([]);
  expect(await aiUsageGateway.snapshot()).toEqual([]);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("ai_usage_snapshot");
});

it("reads account limits through the dedicated metadata command", async () => {
  vi.mocked(invoke).mockResolvedValue({ buckets: [], receivedMs: 1 });
  expect(await codexAccountUsageGateway.read()).toEqual({ buckets: [], receivedMs: 1 });
  expect(invoke).toHaveBeenCalledExactlyOnceWith("ai_codex_account_usage");
});

it("reads local transcript totals through the read-only scan command", async () => {
  const report: TranscriptUsageReport = {
    agents: [{ agent: "opencode", sessions: [{ sessionId: "s1", tokens: { inputTokens: 100, outputTokens: 20 }, updatedMs: 7 }], truncated: false, scannedFiles: 3 }],
    receivedMs: 9,
  };
  vi.mocked(invoke).mockResolvedValue(report);
  expect(await transcriptUsageGateway.read()).toEqual(report);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("ai_transcript_usage");
});

it("forwards only usage observations and releases the event subscription", async () => {
  const cleanup = vi.fn();
  let deliver: ((event: { payload: AiStreamEvent }) => void) | undefined;
  vi.mocked(listen).mockImplementation(async (_event, callback) => {
    deliver = callback as typeof deliver;
    return cleanup;
  });
  const onUsage = vi.fn();
  const stop = await aiUsageGateway.subscribe(onUsage);
  const report: ReportedUsage = { provider: "acp", preset: "codex", runId: "run", sessionId: "session", source: "usage_update", scope: "session", used: 1, size: 100, receivedMs: 1 };
  deliver?.({ payload: { type: "started", payload: { runId: "run" } } });
  deliver?.({ payload: { type: "usage", payload: { runId: "run", usage: report } } });
  deliver?.({ payload: { type: "cancelled", payload: { runId: "run" } } });
  expect(onUsage).toHaveBeenCalledExactlyOnceWith(report);
  expect(invoke).not.toHaveBeenCalled();
  stop();
  expect(cleanup).toHaveBeenCalledOnce();
});
