// Persisted AI provider profiles (non-secret only).
//
// Stored in localStorage so provider/endpoint/model/custom argv and options
// survive restarts. Secrets never touch this store: credentials live in the
// native OS store via `ai_set_credential` and are only referenced by
// presence, never by value.

import type { AcpPreset, AiProviderKind } from "../shared/ai-contracts";
import { DEFAULT_ENDPOINTS } from "./ai";

export interface AiProfile {
  kind: AiProviderKind;
  preset: AcpPreset;
  command: string;
  argsText: string;
  endpoint: string;
  model: string;
  anthropicEnabled: boolean;
}

const STORAGE_KEY = "marxen.ai-profile.v1";

const KINDS: AiProviderKind[] = ["acp", "openai_compatible", "anthropic"];
const PRESETS: AcpPreset[] = ["codex", "opencode", "custom"];

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

function sanitize(raw: unknown): AiProfile {
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
  };
}

export function loadAiProfile(): AiProfile {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return defaultProfile();
    return sanitize(JSON.parse(stored));
  } catch {
    return defaultProfile();
  }
}

export function saveAiProfile(profile: AiProfile): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitize(profile)));
  } catch {
    // Private mode / quota: profiles simply do not persist.
  }
}
