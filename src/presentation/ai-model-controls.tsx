import type { LabelKey } from "../contracts/localization";
import { useI18n } from "./i18n/I18nProvider";
import type { AcpConfigOption, AiProviderConfig, ApiConnectionId } from "../contracts/ai-contracts";
import { defaultProviderConfig, PRESET_LABELS } from "../domain/ai-config";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Bot, Check, ChevronDown, RefreshCw, Settings2 } from "lucide-react";
import type { AiViewPreferences } from "../contracts/ai-view-preferences";
import { aiProviderId, defaultAiViewPreferences, isAiModelVisible, isAiProviderVisible } from "../domain/ai-view-preferences";
import type { ApiConnectionSelection } from "./ai/ApiConnections";
import { ProviderIcon } from "./ai/provider-icon";
import { MODEL_LOGO_PATHS, type ModelVendor } from "./ai/model-logos";

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
  /** Installed ACP presets; others stay hidden unless selected. Null while unknown. */
  installed?: ReadonlySet<string> | null;
}

/** Keep provider, actual model and reasoning controls beside both chat composers. */
export function AiModelControls({ provider, onProvider, options, loading, discovered, error, onRefresh, disabled = false, preferences = defaultAiViewPreferences(), onManageVisibility, connectionSelection, installed = null }: AiModelControlsProps) {
  const { t } = useI18n();
  const selectedProvider = aiProviderId(provider);
  const namedConnections = connectionSelection?.list.connections ?? [];
  const providerChoices = [
    ...Object.entries(PRESET_LABELS).filter(([value]) => isAiProviderVisible(preferences, value as typeof selectedProvider) && (!installed || installed.has(value) || value === selectedProvider)).map(([value, label]) => ({ value, label: t(label as LabelKey), group: t("ACP エージェント"), icon: <ProviderIcon provider={value as typeof selectedProvider} /> })),
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
  const modelOption = options.find((option) => option.category === "model");
  const [modelQuery, setModelQuery] = useState("");
  const effortOption = options.find((option) => option.category === "thought_level");
  /** The value currently selected for one advertised option. */
  const selectedValue = (option: AcpConfigOption) => provider.acp?.selections?.find((item) => item.id === option.id)?.value ?? option.currentValue;
  const modelName = provider.kind === "acp"
    ? (modelOption ? shortModelName(modelOption.options.find((choice) => choice.value === selectedValue(modelOption))?.name ?? selectedValue(modelOption)) : "")
    : provider.openai?.model ?? provider.anthropic?.model ?? "";
  const effortName = effortOption ? effortOption.options.find((choice) => choice.value === selectedValue(effortOption))?.name ?? selectedValue(effortOption) : "";
  const summary = modelName ? `${modelName}${effortName ? ` (${effortName})` : ""}` : switcherLabel;
  return <AgentPicker
    label={t("チャットの接続先とモデル")}
    provider={switcherLabel}
    icon={<ProviderIcon provider={selectedProvider} />}
    summary={summary}
    disabled={disabled}
    onOpen={() => { if (provider.kind === "acp" && !discovered && !loading) onRefresh(); }}
  >
    {preferences.showProviderSelector && <div role="tablist" aria-label={t("チャットの接続先")} className="ai-agent-tabs flex shrink-0 gap-0.5 overflow-x-auto border-b border-border px-1">
      {providerChoices.map((choice) => <button key={choice.value} type="button" role="tab" aria-selected={choice.value === switcherValue} title={"description" in choice && typeof choice.description === "string" ? choice.description : choice.label}
        onClick={() => changeProvider(choice.value)}
        className={`flex shrink-0 items-center gap-1.5 border-b-2 px-2 py-1.5 text-xs ${choice.value === switcherValue ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
        {choice.icon}<span>{choice.label}</span>
      </button>)}
    </div>}
    <div className="min-h-0 flex-1 overflow-y-auto p-1">
      {provider.kind === "acp" ? <>
        {loading && <p role="status" className="px-2 py-2 text-xs text-muted-foreground">{t("接続中…")}</p>}
        {error && <p role="alert" className="px-2 py-2 text-xs text-red-600">{error}</p>}
        {preferences.showModelSelector && modelOption && modelOption.options.length > 10 && <input type="search" aria-label={t("モデルを検索")} placeholder={t("モデルを検索")} value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} className="mb-1 w-full rounded-sm border border-border bg-card px-2 py-1.5 text-xs outline-none focus:border-primary" />}
        {preferences.showModelSelector && modelOption && <div role="listbox" aria-label={t("チャットのモデル")}>
          {modelOption.options.filter((choice) => isAiModelVisible(preferences, selectedProvider, modelOption.id, choice.value, scopedConnectionId) && `${choice.name} ${choice.value}`.toLocaleLowerCase().includes(modelQuery.trim().toLocaleLowerCase())).map((choice) => {
            const selected = choice.value === selectedValue(modelOption);
            return <button key={choice.value} type="button" role="option" aria-selected={selected} title={choice.value}
              onClick={() => changeChoice(modelOption.id, choice.value)}
              className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs ${selected ? "bg-muted" : "hover:bg-muted/70"}`}>
              <ModelIcon model={`${choice.value} ${choice.name}`} />
              <span className="min-w-0 flex-1 truncate">{shortModelName(choice.name)}</span>
              <Check size={13} className={selected ? "shrink-0 text-primary" : "invisible shrink-0"} aria-hidden="true" />
            </button>;
          })}
        </div>}
        {preferences.showModelSelector && discovered && !loading && !error && !modelOption && <p className="px-2 py-2 text-xs text-muted-foreground">{t("モデル候補なし（接続先の設定を使用）")}</p>}
      </> : preferences.showModelSelector && <label className="block px-2 py-2 text-xs"><span className="sr-only">{t("チャットのモデル")}</span><input aria-label={t("チャットのモデル")} placeholder={t("モデル名を入力")} value={provider.openai?.model ?? provider.anthropic?.model ?? ""} disabled={disabled} onChange={(event) => changeApiModel(event.target.value)} className="w-full rounded-sm border border-border bg-card px-2 py-1.5 outline-none focus:border-primary" /></label>}
    </div>
    {preferences.showModelSelector && provider.kind === "acp" && effortOption && <div role="radiogroup" aria-label={t("チャットの推論強度")} className="flex flex-wrap items-center gap-1 border-t border-border px-2 py-1.5">
      {effortOption.options.map((choice) => {
        const selected = choice.value === selectedValue(effortOption);
        return <button key={choice.value} type="button" role="radio" aria-checked={selected} onClick={() => changeChoice(effortOption.id, choice.value)}
          className={`rounded-sm px-2 py-0.5 text-xs ${selected ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>{choice.name}</button>;
      })}
    </div>}
    <div className="flex items-center gap-1 border-t border-border px-1 py-1">
      {provider.kind === "acp" && <button type="button" className="inline-flex items-center rounded-sm p-1 text-muted-foreground hover:bg-muted" disabled={disabled || loading} onClick={onRefresh} aria-label={t("接続して候補を確認")} title={t("接続して候補を確認")}><RefreshCw size={12} aria-hidden="true" className={loading ? "animate-spin" : undefined} /></button>}
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{hiddenCurrent ? t("選択中の候補は非表示です") : ""}</span>
      {onManageVisibility && <button type="button" className="inline-flex items-center rounded-sm p-1 text-muted-foreground hover:bg-muted" onClick={onManageVisibility} aria-label={t("AI の表示設定")} title={t("AI の表示設定")}><Settings2 size={13} aria-hidden="true" /></button>}
    </div>
  </AgentPicker>;
}

/** Last segment of an advertised model name, dropping account and provider prefixes. */
export function shortModelName(name: string): string {
  return name.split("/").at(-1)!.trim() || name;
}

const VENDOR_PATTERNS: Array<[ModelVendor, RegExp]> = [
  ["anthropic", /claude|anthropic|opus|sonnet|haiku|fable/],
  ["gemini", /gemini|gemma|google/],
  ["openai", /gpt|openai|codex|\bo[1-9]\b/],
  ["deepseek", /deepseek/],
  ["qwen", /qwen|qwq|alibaba|tongyi/],
  ["kimi", /kimi|moonshot/],
  ["glm", /glm|zhipu/],
  ["minimax", /minimax|abab/],
  ["grok", /grok|xai/],
  ["mistral", /mistral|codestral|devstral|magistral|ministral|pixtral/],
  ["meta", /llama|meta/],
  ["xiaomi", /mimo|xiaomi/],
  ["nvidia", /nemotron|nvidia/],
];

/** Vendor behind a model ID or name, for its icon. */
export function modelVendor(model: string): ModelVendor | "other" {
  const text = model.toLowerCase();
  return VENDOR_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? "other";
}

/** Vendor mark for one model choice; unknown vendors get a generic mark. */
function ModelIcon({ model }: { model: string }) {
  const vendor = modelVendor(model);
  if (vendor === "other") return <Bot size={14} aria-hidden="true" data-model-icon="other" />;
  return <svg width={14} height={14} viewBox="0 0 40 40" fill="currentColor" aria-hidden="true" data-model-icon={vendor}><path d={MODEL_LOGO_PATHS[vendor]} /></svg>;
}

/** Inputs of the compact agent/model picker. */
interface AgentPickerProps {
  label: string;
  /** Provider name, exposed on the trigger for tooltips and tests. */
  provider: string;
  icon: ReactNode;
  /** "model (effort)" or the provider name when no model is known. */
  summary: string;
  disabled: boolean;
  /** Called just before the panel opens, to fetch models. */
  onOpen: () => void;
  children: ReactNode;
}

/**
 * One compact trigger (provider icon, then "model (effort)" when there is room)
 * opening a panel with provider tabs, models and effort.
 *
 * The label hides itself in narrow composers so the row never wraps.
 */
function AgentPicker({ label, provider, icon, summary, disabled, onOpen, children }: AgentPickerProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, bottom: 8, width: 340 });
  useLayoutEffect(() => {
    if (!open) return;
    /** Keep the panel above its trigger and inside the viewport. */
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
      const width = Math.min(340, window.innerWidth - 16);
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), bottom: window.innerHeight - rect.top + 4, width });
    };
    place(); window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    /** Close when the pointer goes down outside the trigger and panel. */
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const host = trigger.current?.closest<HTMLElement>("[data-theme]") ?? document.body;
  return <div className="ai-model-controls @container min-w-0">
    <button ref={trigger} type="button" aria-label={label} aria-expanded={open} aria-haspopup="dialog" disabled={disabled} title={`${provider} · ${summary}`} data-provider={provider}
      onClick={() => { if (!open) onOpen(); setOpen(!open); }}
      onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); } }}
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-xs text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50">
      <span className="shrink-0">{icon}</span>
      <span className="hidden truncate @[7rem]:inline">{summary}</span>
      <ChevronDown size={12} className="shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={panel} role="dialog" aria-label={label}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); trigger.current?.focus(); } }}
      className="fixed z-[70] flex max-h-[min(420px,70vh)] flex-col overflow-hidden rounded-md border border-border bg-card text-foreground shadow-xl"
      style={{ left: position.left, bottom: position.bottom, width: position.width }}>
      {children}
    </div>, host)}
  </div>;
}
