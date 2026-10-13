import { describe, expect, it } from "vitest";
import type { ReportedUsage } from "../contracts/ai-contracts";
import { contextOccupancy, latestAgentUsage, rememberUsage } from "./ai-usage";

/** Make one reported observation with no fabricated counters or costs. */
function usage(overrides: Partial<ReportedUsage> = {}): ReportedUsage {
  return { provider: "acp", preset: "codex", runId: "run", sessionId: "session", source: "usage_update", scope: "session", receivedMs: 1, ...overrides };
}

describe("reported agent usage", () => {
  it("retains context and session cost when the response reports tokens", () => {
    const context = usage({ used: 500, size: 1000, cost: { amount: "0.12", currency: "USD" } });
    const tokens = usage({ source: "prompt_response", scope: "prompt_response_undefined", totalTokens: 40, inputTokens: 30, outputTokens: 10, receivedMs: 2 });
    const [result] = latestAgentUsage([context, tokens]);
    expect(result.context).toEqual({ used: 500, size: 1000 });
    expect(result.cost).toEqual(context.cost);
    expect(result.tokens).toEqual(tokens);
    expect(contextOccupancy(result.context)).toBe(50);
  });

  it("never borrows context or cost from another run or wire session", () => {
    const old = usage({ used: 500, size: 1000, cost: { amount: "1", currency: "USD" } });
    for (const changed of [{ runId: "next-run" }, { sessionId: "next-session" }]) {
      const [result] = latestAgentUsage([old, usage({ ...changed, source: "prompt_response", scope: "prompt_response_undefined", totalTokens: 2, receivedMs: 2 })]);
      expect(result.context).toBeUndefined();
      expect(result.cost).toBeUndefined();
      expect(result.tokens?.totalTokens).toBe(2);
    }
  });

  it("keeps provider observations separate and leaves absent values absent", () => {
    const rows = latestAgentUsage([usage(), usage({ preset: "opencode", receivedMs: 2 }), usage({ provider: "openai_compatible", preset: undefined, receivedMs: 3 })]);
    expect(rows.map((row) => row.key)).toEqual(["openai_compatible", "acp:opencode", "acp:codex"]);
    for (const row of rows) {
      expect(row.context).toBeUndefined();
      expect(row.cost).toBeUndefined();
      expect(row.tokens).toBeUndefined();
    }
    expect(contextOccupancy(undefined)).toBeUndefined();
    expect(contextOccupancy({ used: 0, size: 0 })).toBeUndefined();
  });

  it("replaces a source without summing tokens or erasing the other source", () => {
    const old = usage({ used: 20, size: 100 });
    const token = usage({ source: "prompt_response", scope: "prompt_response_undefined", totalTokens: 10, receivedMs: 2 });
    const current = usage({ used: 30, size: 100, receivedMs: 3 });
    expect(rememberUsage([old, token], current)).toEqual([token, current]);
    const [row] = latestAgentUsage(rememberUsage([old, token], current));
    expect(row.context?.used).toBe(30);
    expect(row.tokens?.totalTokens).toBe(10);
  });

  it("keeps only the bounded newest observations", () => {
    let reports: ReportedUsage[] = [];
    for (let index = 0; index < 35; index += 1) reports = rememberUsage(reports, usage({ runId: `run-${index}`, receivedMs: index }));
    expect(reports).toHaveLength(32);
    expect(reports[0].runId).toBe("run-3");
    expect(reports.at(-1)?.runId).toBe("run-34");
  });

  it("keeps a newer streamed report when an older snapshot arrives later", () => {
    const streamed = usage({ used: 30, size: 100, receivedMs: 3 });
    const snapshot = usage({ used: 10, size: 100, receivedMs: 1 });
    expect(rememberUsage([streamed], snapshot)).toEqual([streamed]);
  });
});
