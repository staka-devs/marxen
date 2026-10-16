import type { AiProviderConfig, ApiConnectionId } from "../contracts/ai-contracts";
import type { AiProviderId, AiViewPreferences, HiddenAiModel } from "../contracts/ai-view-preferences";
import { isConnectionId } from "./ai-connections";

/** Supported adapters, without assumed model IDs. */
export const AI_PROVIDER_IDS: readonly AiProviderId[] = ["codex", "opencode", "copilot", "claude_code", "devin", "custom", "openai_chat_completions", "openai_responses", "anthropic"];
export const AI_CHAT_WIDTH = { min: 280, max: 720, default: 360, step: 16 } as const;

/** Build independent first-run preferences. */
export function defaultAiViewPreferences(): AiViewPreferences {
  return { showProviderSelector: true, showModelSelector: true, hiddenProviders: [], hiddenConnectionIds: [], hiddenModels: [], chatPaneWidth: AI_CHAT_WIDTH.default };
}

/** Resolve the configured adapter without testing or changing its connection. */
export function aiProviderId(provider: AiProviderConfig): AiProviderId {
  return provider.kind === "acp" ? provider.acp?.preset ?? "codex" : provider.kind;
}

/** Bound pane width to the workspace, yielding space gracefully on very narrow windows. */
export function clampAiChatWidth(width: number, availableWidth = Infinity): number {
  const available = Math.max(0, Number.isFinite(availableWidth) ? availableWidth : Infinity);
  const max = Math.min(AI_CHAT_WIDTH.max, available < AI_CHAT_WIDTH.min + 240 ? available : available - 240);
  const min = Math.min(AI_CHAT_WIDTH.min, max);
  return Math.round(Math.min(max, Math.max(min, Number.isFinite(width) ? width : AI_CHAT_WIDTH.default)));
}

/** Sanitize persisted view state without consulting or mutating native connection selections. */
export function normalizeAiViewPreferences(value: unknown): AiViewPreferences {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const defaults = defaultAiViewPreferences();
  const storedProviders = Array.isArray(raw.hiddenProviders) ? raw.hiddenProviders : [];
  const hiddenProviders = AI_PROVIDER_IDS.filter((id) => storedProviders.includes(id));
  const hiddenConnectionIds = Array.isArray(raw.hiddenConnectionIds) ? [...new Set(raw.hiddenConnectionIds.filter(isConnectionId))] : [];
  const hiddenModels: HiddenAiModel[] = [];
  if (Array.isArray(raw.hiddenModels)) for (const item of raw.hiddenModels.slice(0, 4096)) {
    if (!item || !AI_PROVIDER_IDS.includes(item.provider) || typeof item.optionId !== "string" || typeof item.value !== "string" || !item.optionId || !item.value || item.optionId.length > 1024 || item.value.length > 1024) continue;
    // A present but malformed scope drops the entry instead of demoting it:
    // demotion would leak a per-connection hide into provider-wide behavior.
    if (item.connectionId !== undefined && !isConnectionId(item.connectionId)) continue;
    const connectionId = isConnectionId(item.connectionId) ? item.connectionId : undefined;
    if (!hiddenModels.some((entry) => entry.provider === item.provider && entry.optionId === item.optionId && entry.value === item.value && (entry.connectionId ?? null) === (connectionId ?? null))) hiddenModels.push(connectionId === undefined ? { provider: item.provider, optionId: item.optionId, value: item.value } : { provider: item.provider, optionId: item.optionId, value: item.value, connectionId });
  }
  return {
    showProviderSelector: typeof raw.showProviderSelector === "boolean" ? raw.showProviderSelector : defaults.showProviderSelector,
    showModelSelector: typeof raw.showModelSelector === "boolean" ? raw.showModelSelector : defaults.showModelSelector,
    hiddenProviders, hiddenConnectionIds, hiddenModels,
    chatPaneWidth: clampAiChatWidth(typeof raw.chatPaneWidth === "number" ? raw.chatPaneWidth : defaults.chatPaneWidth),
  };
}

/** Check named profiles by stable ID and legacy/ACP choices by their independent provider kind. */
export function isAiProviderVisible(preferences: AiViewPreferences, provider: AiProviderId, connectionId?: ApiConnectionId | null): boolean {
  return connectionId ? !(preferences.hiddenConnectionIds ?? []).includes(connectionId) : !preferences.hiddenProviders.includes(provider);
}

/** Toggle a named profile's candidates without changing selection, credentials or model visibility. */
export function setAiConnectionVisible(preferences: AiViewPreferences, connectionId: ApiConnectionId, visible: boolean): AiViewPreferences {
  const hidden = preferences.hiddenConnectionIds ?? [];
  return { ...preferences, hiddenConnectionIds: visible ? hidden.filter((id) => id !== connectionId) : [...new Set([...hidden, connectionId])] };
}

/** Determine whether an advertised model belongs in a selector. */
export function isAiModelVisible(preferences: AiViewPreferences, provider: AiProviderId, optionId: string, value: string, connectionId?: string | null): boolean {
  return !preferences.hiddenModels.some((entry) => entry.provider === provider && entry.optionId === optionId && entry.value === value && (entry.connectionId ?? null) === (connectionId ?? null));
}

/** Toggle a provider's candidate visibility without touching the current provider. */
export function setAiProviderVisible(preferences: AiViewPreferences, provider: AiProviderId, visible: boolean): AiViewPreferences {
  return { ...preferences, hiddenProviders: visible ? preferences.hiddenProviders.filter((id) => id !== provider) : [...new Set([...preferences.hiddenProviders, provider])] };
}

/** Toggle one actual model ID without touching native selections or related reasoning options. */
export function setAiModelVisible(preferences: AiViewPreferences, model: HiddenAiModel, visible: boolean): AiViewPreferences {
  const scope = model.connectionId ?? null;
  const retained = preferences.hiddenModels.filter((entry) => entry.provider !== model.provider || entry.optionId !== model.optionId || entry.value !== model.value || (entry.connectionId ?? null) !== scope);
  return { ...preferences, hiddenModels: visible ? retained : [...retained, model] };
}
