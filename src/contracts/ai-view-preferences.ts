import type { AcpConfigOption } from "./ai-contracts";

/** Supported connection choices; these identifiers never assert connection health. */
export type AiProviderId = "codex" | "opencode" | "copilot" | "custom" | "openai_compatible" | "anthropic";

/** One hidden advertised value, scoped by provider and the agent's actual option ID. */
export interface HiddenAiModel {
  provider: AiProviderId;
  optionId: string;
  value: string;
}

/** View-only AI preferences, independent of credentials, native selections and editor settings. */
export interface AiViewPreferences {
  showProviderSelector: boolean;
  showModelSelector: boolean;
  hiddenProviders: AiProviderId[];
  hiddenModels: HiddenAiModel[];
  chatPaneWidth: number;
}

/** Actual discovery metadata for a supported provider; absence means unknown, never an invented list. */
export interface AdvertisedAiProvider {
  provider: AiProviderId;
  options: AcpConfigOption[];
  discovered: boolean;
}
