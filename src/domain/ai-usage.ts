import type { ReportedUsage, UsageCost } from "../contracts/ai-contracts";

/** Latest observations for one provider, limited to the same run and wire session. */
export interface AgentUsage {
  key: string;
  provider: ReportedUsage["provider"];
  preset?: ReportedUsage["preset"];
  runId: string;
  sessionId: string;
  receivedMs: number;
  context?: { used: number; size: number };
  cost?: UsageCost;
  tokens?: ReportedUsage;
}

/** Identify an agent without equating separate providers or ACP presets. */
export function usageProviderKey(usage: Pick<ReportedUsage, "provider" | "preset">): string {
  return usage.provider === "acp" ? `acp:${usage.preset ?? "custom"}` : usage.provider;
}

/** Keep context and response-token observations separate and never add counters. */
export function latestAgentUsage(reports: readonly ReportedUsage[]): AgentUsage[] {
  const latest = new Map<string, ReportedUsage>();
  for (const report of reports) {
    const key = usageProviderKey(report);
    const previous = latest.get(key);
    if (!previous || report.receivedMs >= previous.receivedMs) latest.set(key, report);
  }
  return [...latest].map(([key, newest]) => {
    const summary: AgentUsage = {
      key, provider: newest.provider, preset: newest.preset, runId: newest.runId,
      sessionId: newest.sessionId, receivedMs: newest.receivedMs,
    };
    const sources = new Map<ReportedUsage["source"], ReportedUsage>();
    for (const report of reports) {
      if (usageProviderKey(report) !== key || report.runId !== newest.runId || report.sessionId !== newest.sessionId) continue;
      const previous = sources.get(report.source);
      if (!previous || report.receivedMs >= previous.receivedMs) sources.set(report.source, report);
    }
    const context = sources.get("usage_update");
    if (context?.used !== undefined && context.size !== undefined) summary.context = { used: context.used, size: context.size };
    if (context?.cost !== undefined) summary.cost = context.cost;
    const tokens = sources.get("prompt_response");
    if (tokens !== undefined) summary.tokens = tokens;
    return summary;
  }).sort((a, b) => b.receivedMs - a.receivedMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Compute context occupancy only when the reported window has a positive size. */
export function contextOccupancy(context: AgentUsage["context"]): number | undefined {
  return context && context.size > 0 ? context.used / context.size * 100 : undefined;
}

/** Retain the latest observation of each source for a run/session in a bounded set. */
export function rememberUsage(reports: readonly ReportedUsage[], report: ReportedUsage): ReportedUsage[] {
  const previous = reports.find((item) => item.runId === report.runId && item.sessionId === report.sessionId && item.source === report.source);
  if (previous && previous.receivedMs > report.receivedMs) return [...reports];
  const next = reports.filter((item) => !(item.runId === report.runId && item.sessionId === report.sessionId && item.source === report.source));
  next.push(report);
  return next.sort((a, b) => a.receivedMs - b.receivedMs).slice(-32);
}
