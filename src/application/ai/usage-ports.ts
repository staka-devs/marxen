import type { CodexAccountUsage, ReportedUsage, TranscriptUsageReport } from "../../contracts/ai-contracts";

/** Read reported usage without starting an agent or sending a prompt. */
export interface AiUsageGateway {
  /** Read bounded observations already received by the native AI service. */
  snapshot(): Promise<ReportedUsage[]>;
  /** Subscribe to usage observations, returning an explicit listener cleanup. */
  subscribe(onUsage: (usage: ReportedUsage) => void): Promise<() => void>;
}

/** Read installed Codex account limits independently of prompt observations. */
export interface CodexAccountUsageGateway {
  /** Request official account metadata without creating a conversation or inference. */
  read(): Promise<CodexAccountUsage>;
}

/** Read locally measured transcript totals without starting an agent or inference. */
export interface TranscriptUsageGateway {
  /** Scan read-only local transcript stores and return the measured report. */
  read(): Promise<TranscriptUsageReport>;
}
