import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AiUsageGateway, CodexAccountUsageGateway, TranscriptUsageGateway } from "../../application/ai/usage-ports";
import type { AiStreamEvent, CodexAccountUsage, ReportedUsage, TranscriptUsageReport } from "../../contracts/ai-contracts";
import { AI_STREAM_EVENT } from "../../domain/ai-config";
import { requireDesktop } from "./ai-client";

/** Read existing native usage and subscribe without starting inference. */
export const aiUsageGateway: AiUsageGateway = {
  /** Return bounded native reports through the read-only snapshot command. */
  async snapshot() {
    requireDesktop();
    return invoke<ReportedUsage[]>("ai_usage_snapshot");
  },
  /** Forward only usage events and return the native listener cleanup. */
  async subscribe(onUsage) {
    requireDesktop();
    return listen<AiStreamEvent>(AI_STREAM_EVENT, ({ payload }) => {
      if (payload.type === "usage") onUsage(payload.payload.usage);
    });
  },
};

/** Read official Codex account limits through the native bounded process adapter. */
export const codexAccountUsageGateway: CodexAccountUsageGateway = {
  /** Request usage metadata without starting an AI turn or handling credentials in JavaScript. */
  async read() {
    requireDesktop();
    return invoke<CodexAccountUsage>("ai_codex_account_usage");
  },
};

/** Read locally measured transcript totals through the native read-only scanner. */
export const transcriptUsageGateway: TranscriptUsageGateway = {
  /** Scan default transcript stores without starting an agent or handling credentials in JavaScript. */
  async read() {
    requireDesktop();
    return invoke<TranscriptUsageReport>("ai_transcript_usage");
  },
};
