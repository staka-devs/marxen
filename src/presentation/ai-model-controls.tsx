import type { LabelKey } from "../contracts/localization";
import { useI18n } from "./i18n/I18nProvider";
import type { AcpConfigOption, AiProviderConfig, ApiConnectionId } from "../contracts/ai-contracts";
import { defaultProviderConfig, PRESET_LABELS } from "../domain/ai-config";
import { RefreshCw } from "lucide-react";
import { Settings2 } from "lucide-react";
import { ChoiceMenu } from "./ui/choice-menu";
import type { AiViewPreferences } from "../contracts/ai-view-preferences";
import { aiProviderId, defaultAiViewPreferences, isAiModelVisible, isAiProviderVisible } from "../domain/ai-view-preferences";
import type { ApiConnectionSelection } from "./ai/ApiConnections";
import { ProviderIcon } from "./ai/provider-icon";

interface AiModelControlsProps {
  provider: AiProviderConfig;
  /** Replace the active non-secret chat provider, reporting persistence failures. */
  onProvider: (provider: AiProviderConfig) => boolean | void;
  options: AcpConfigOption[];
  loading: boolean;
  discovered: boolean;
  error: string | null;
  /** Explicitly inspect the connected agent for actual model choices. */
  onRefresh: () => void;
  disabled?: boolean;
  preferences?: AiViewPreferences;
  /** Open visibility management while preserving the active connection and selections. */
  onManageVisibility?: () => void;
  /** Registered named API connections; protocols are chosen only when adding an API. */
  connectionSelection?: ApiConnectionSelection;
}

/** Keep provider, actual model and reasoning controls beside both chat composers. */
export function AiModelControls({ provider, onProvider, options, loading, discovered, error, onRefresh, disabled = false, preferences = defaultAiViewPreferences(), onManageVisibility, connectionSelection }: AiModelControlsProps) {
  const { t } = useI18n();
  const selectedProvider = aiProviderId(provider);
  const namedConnections = connectionSelection?.list.connections ?? [];
  const providerChoices = [
    ...Object.entries(PRESET_LABELS).filter(([value]) => isAiProviderVisible(preferences, value as typeof selectedProvider)).map(([value, label]) => ({ value, label: t(label as LabelKey), group: t("ACP エージェント"), icon: <ProviderIcon provider={value as typeof selectedProvider} /> })),
    ...namedConnections.filter((connection) => isAiProviderVisible(preferences, connection.protocol, connection.id)).map((connection) => ({ value: connection.id as string, label: connection.name, description: connection.model === "" ? connection.endpoint : `${connection.model} • ${connection.endpoint}`, group: t("直接 API"), icon: <ProviderIcon provider={connection.protocol} /> })),
  ];
  /** Chat switcher value: the stable connection ID for named API use, else the provider ID. */
  const providerScopeId = provider.connectionId ?? null;
  const switcherValue = provider.kind !== "acp" ? (providerScopeId && namedConnections.some((connection) => connection.id === providerScopeId) ? providerScopeId : "") : selectedProvider;
  /** Active named connection backing the label, or null for ACP and legacy providers. */
  const activeConnection = providerScopeId ? (namedConnections?.find((connection) => connection.id === providerScopeId) ?? null) : null;
  /**
   * Stable connection backing a named API provider, or null otherwise.
   *
   * Derived from the actual provider connectionId so ACP and stale selections
   * never share hide state; same-protocol twins never share hide state either.
   */
  const scopedConnectionId = providerScopeId;
  const switcherLabel = activeConnection?.name ?? (selectedProvider === "openai_responses" ? "OpenAI Responses" : selectedProvider === "openai_chat_completions" ? t("OpenAI Chat Completions") : selectedProvider === "anthropic" ? "Anthropic API" : t(PRESET_LABELS[selectedProvider] as LabelKey));
  const hiddenCurrent = !isAiProviderVisible(preferences, selectedProvider, provider.kind === "acp" ? null : providerScopeId) || options.some((option) => option.category === "model" && !isAiModelVisible(preferences, selectedProvider, option.id, provider.acp?.selections?.find((item) => item.id === option.id)?.value ?? option.currentValue, scopedConnectionId));
  /** Switch to a configured adapter or an API profile without starting or authenticating it. */
  function changeProvider(value: string) {
    if (value === switcherValue) return;
    if (namedConnections.some((connection) => connection.id === value)) {
      connectionSelection?.onSelect(value as ApiConnectionId);
      return;
    }
    if (!(Object.keys(PRESET_LABELS) as string[]).includes(value)) return;
    onProvider({ ...defaultProviderConfig("acp"), acp: { preset: value as NonNullable<AiProviderConfig["acp"]>["preset"], argv: value === "custom" ? provider.acp?.argv ?? { command: "", args: [] } : null } });
  }
  /** Store one advertised choice; native validation and acknowledgment precede every prompt. */
  function changeChoice(id: string, value: string) {
    if (!provider.acp) return;
    const option = options.find((item) => item.id === id);
    const current = provider.acp.selections ?? [];
    if ((current.find((item) => item.id === id)?.value ?? option?.currentValue) === value) return;
    // A model change invalidates its dependent reasoning override.
    const preserved = current.filter((item) => item.id !== id && (option?.category !== "model" || options.find((entry) => entry.id === item.id)?.category !== "thought_level"));
    onProvider({ ...provider, acp: { ...provider.acp, selections: [...preserved, { id, value }] } });
  }
  /** Update the direct API model name while preserving its endpoint and opt-in state. */
  function changeApiModel(model: string) {
    if (provider.openai) onProvider({ ...provider, openai: { ...provider.openai, model } });
    else if (provider.anthropic) onProvider({ ...provider, anthropic: { ...provider.anthropic, model } });
  }
  return <div className="ai-model-controls">
    {preferences.showProviderSelector && <ChoiceMenu label={t("チャットの接続先")} value={switcherValue} valueLabel={switcherLabel} valueIcon={<ProviderIcon provider={selectedProvider} />} disabled={disabled} onChange={changeProvider} searchLabel={t("接続先を検索")} emptyLabel={t("候補がありません。表示設定を確認してください。")} choices={providerChoices} />}
    {provider.kind === "acp" ? <>
      {preferences.showModelSelector && options.filter((option) => option.category === "model" || option.category === "thought_level").map((option) => {
        const value = provider.acp?.selections?.find((item) => item.id === option.id)?.value ?? option.currentValue;
        return <ChoiceMenu key={option.id} label={option.category === "model" ? t("チャットのモデル") : t("チャットの推論強度")} value={value} valueLabel={option.options.find((choice) => choice.value === value)?.name ?? value} disabled={disabled || loading} onChange={(next) => changeChoice(option.id, next)} searchLabel={option.category === "model" ? t("モデルを検索") : undefined} emptyLabel={t("候補がありません。表示設定を確認してください。")} choices={option.options.filter((choice) => option.category !== "model" || isAiModelVisible(preferences, selectedProvider, option.id, choice.value, scopedConnectionId)).map((choice) => ({ value: choice.value, label: choice.name, description: choice.value, group: option.name }))} />;
      })}
      <button type="button" className="ai-model-refresh inline-flex items-center gap-1" disabled={disabled || loading} onClick={onRefresh} aria-label={t("接続して候補を確認")} title={t("接続して候補を確認")}><RefreshCw size={12} aria-hidden="true" className={loading ? "animate-spin" : undefined} />{loading ? t("接続中…") : t("接続を確認")}</button>
      {preferences.showModelSelector && discovered && !loading && !error && !options.some((option) => option.category === "model" && option.options.length > 0) && <small>{t("モデル候補なし（接続先の設定を使用）")}</small>}
    </> : preferences.showModelSelector && <label className="ai-model-api"><span className="sr-only">{t("チャットのモデル")}</span><input aria-label={t("チャットのモデル")} placeholder={t("モデル名を入力")} value={provider.openai?.model ?? provider.anthropic?.model ?? ""} disabled={disabled} onChange={(event) => changeApiModel(event.target.value)} /></label>}
    {onManageVisibility && <button type="button" className="inline-flex items-center gap-1 rounded-sm px-1.5 py-1 text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary" onClick={onManageVisibility} aria-label={t("AI の表示設定")} title={t("AI の表示設定")}><Settings2 size={13} aria-hidden="true" />{hiddenCurrent ? t("選択中の候補は非表示です") : null}</button>}
    {error && <small role="alert">{error}</small>}
  </div>;
}
