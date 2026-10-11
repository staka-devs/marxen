// Deterministic AI profile model (domain).
//
// Non-secret provider/endpoint/model/custom argv and options. No Tauri, DOM,
// React, or browser globals: persistence lives in infrastructure storage and
// secrets never touch this model.

import type { AcpPreset, AiProviderKind, AcpSelection } from "../contracts/ai-contracts";
import { DEFAULT_ENDPOINTS } from "./ai-config";

/** Persisted non-secret AI provider profile. */
export interface AiProfile {
  kind: AiProviderKind;
  preset: AcpPreset;
  command: string;
  argsText: string;
  endpoint: string;
  model: string;
  anthropicEnabled: boolean;
  acpSelections?: AcpSelection[];
}

/** Valid provider kinds accepted from stored JSON. */
const KINDS: AiProviderKind[] = ["acp", "openai_compatible", "anthropic"];

/** Valid ACP presets accepted from stored JSON. */
const PRESETS: AcpPreset[] = ["codex", "opencode", "copilot", "custom"];

/**
 * Create the default Codex profile for first-run settings.
 *
 * Uses the OpenAI-compatible default endpoint as the placeholder so manual
 * inputs start from a valid shape.
 */
export function defaultProfile(): AiProfile {
  return {
    kind: "acp",
    preset: "codex",
    command: "",
    argsText: "",
    endpoint: DEFAULT_ENDPOINTS.openai_compatible,
    model: "",
    anthropicEnabled: false,
  };
}

/**
 * Sanitize unknown stored JSON into a valid profile, falling back per field.
 *
 * Unknown kinds/presets reset to defaults; non-string command/args/model
 * reset to empty; empty endpoints reset to the default placeholder.
 */
export function sanitizeAiProfile(raw: unknown): AiProfile {
  const fallback = defaultProfile();
  if (typeof raw !== "object" || raw === null) return fallback;
  const record = raw as Record<string, unknown>;
  return {
    kind: KINDS.includes(record.kind as AiProviderKind) ? (record.kind as AiProviderKind) : fallback.kind,
    preset: PRESETS.includes(record.preset as AcpPreset) ? (record.preset as AcpPreset) : fallback.preset,
    command: typeof record.command === "string" ? record.command : "",
    argsText: typeof record.argsText === "string" ? record.argsText : "",
    endpoint: typeof record.endpoint === "string" && record.endpoint !== "" ? record.endpoint : fallback.endpoint,
    model: typeof record.model === "string" ? record.model : "",
    anthropicEnabled: record.anthropicEnabled === true,
    acpSelections: Array.isArray(record.acpSelections) ? record.acpSelections.filter((item): item is AcpSelection => typeof item?.id === "string" && typeof item?.value === "string" && item.id.length <= 256 && item.value.length <= 256).slice(0, 8) : undefined,
  };
}
