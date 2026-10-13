import type { LabelKey } from "../contracts/localization";
import { useI18n } from "./i18n/I18nProvider";
import type { AcpConfigOption, AiProviderConfig } from "../contracts/ai-contracts";
import { defaultProviderConfig, PRESET_LABELS } from "../domain/ai-config";
import { RefreshCw } from "lucide-react";
import { ChoiceMenu } from "./ui/choice-menu";

interface AiModelControlsProps {
  provider: AiProviderConfig;
  /** Replace the active non-secret chat provider. */
  onProvider: (provider: AiProviderConfig) => void;
  options: AcpConfigOption[];
  loading: boolean;
  discovered: boolean;
  error: string | null;
  /** Explicitly inspect the connected agent for actual model choices. */
  onRefresh: () => void;
  disabled?: boolean;
}

/** Keep provider, actual model and reasoning controls beside both chat composers. */
export function AiModelControls({ provider, onProvider, options, loading, discovered, error, onRefresh, disabled = false }: AiModelControlsProps) {
  const { t } = useI18n();
  const selectedProvider = provider.kind === "acp" ? provider.acp?.preset ?? "codex" : provider.kind;
  /** Switch to a configured adapter or an API profile without starting or authenticating it. */
  function changeProvider(value: string) {
    if (value === "openai_compatible" || value === "anthropic") {
      onProvider(provider.kind === value ? provider : defaultProviderConfig(value));
    } else {
      onProvider({ ...defaultProviderConfig("acp"), acp: { preset: value as NonNullable<AiProviderConfig["acp"]>["preset"], argv: value === "custom" ? provider.acp?.argv ?? { command: "", args: [] } : null } });
    }
  }
  /** Store one advertised choice; native validation and acknowledgment precede every prompt. */
  function changeChoice(id: string, value: string) {
    if (!provider.acp) return;
    const option = options.find((item) => item.id === id);
    const current = provider.acp.selections ?? [];
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
    <ChoiceMenu label={t("チャットの接続先")} value={selectedProvider} disabled={disabled} onChange={changeProvider} choices={[
      ...Object.entries(PRESET_LABELS).map(([value, label]) => ({ value, label: t(label as LabelKey) })),
      { value: "openai_compatible", label: t("OpenAI 互換 API") }, { value: "anthropic", label: "Anthropic API" },
    ]} />
    {provider.kind === "acp" ? <>
      {options.map((option) => <ChoiceMenu key={option.id} label={option.category === "model" ? t("チャットのモデル") : t("チャットの推論強度")} value={provider.acp?.selections?.find((item) => item.id === option.id)?.value ?? option.currentValue} disabled={disabled || loading} onChange={(value) => changeChoice(option.id, value)} choices={option.options.map((choice) => ({ value: choice.value, label: choice.name }))} />)}
      <button type="button" className="ai-model-refresh inline-flex items-center gap-1" disabled={disabled || loading} onClick={onRefresh} aria-label={t("モデル候補を取得")} title={t("接続先が公開するモデル候補を取得")}><RefreshCw size={12} aria-hidden="true" className={loading ? "animate-spin" : undefined} />{loading ? t("接続中…") : discovered ? null : t("モデルを選ぶ")}</button>
      {discovered && !loading && !error && options.length === 0 && <small>{t("この接続先はモデル候補を公開していません。CLI の設定を使用します。")}</small>}
    </> : <label className="ai-model-api"><span className="sr-only">{t("チャットのモデル")}</span><input aria-label={t("チャットのモデル")} placeholder={t("モデル名を入力")} value={provider.openai?.model ?? provider.anthropic?.model ?? ""} disabled={disabled} onChange={(event) => changeApiModel(event.target.value)} /></label>}
    {error && <small role="alert">{error}</small>}
  </div>;
}
