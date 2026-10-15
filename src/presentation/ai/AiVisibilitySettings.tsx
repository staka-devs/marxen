import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AdvertisedAiProvider, AiViewPreferences } from "../../contracts/ai-view-preferences";
import type { ApiConnection } from "../../contracts/ai-contracts";
import type { LabelKey } from "../../contracts/localization";
import { AI_PROVIDER_IDS, AI_CHAT_WIDTH, isAiModelVisible, isAiProviderVisible, setAiConnectionVisible, setAiModelVisible, setAiProviderVisible } from "../../domain/ai-view-preferences";
import { PRESET_LABELS } from "../../domain/ai-config";
import { useI18n } from "../i18n/I18nProvider";
import { trapDialogTab } from "../workspace/dialogFocus";
import { ProviderIcon } from "./provider-icon";
import { describeApiConnection } from "./ApiConnections";

export interface AiVisibilitySettingsProps {
  preferences: AiViewPreferences;
  /** Apply only view preferences, never the active provider or model configuration. */
  onPreferences: (next: AiViewPreferences) => void;
  advertisedProviders: readonly AdvertisedAiProvider[];
  /** Registered named API profiles; when non-empty they replace the single direct-API kinds. */
  connections?: readonly ApiConnection[];
  saveFailed?: boolean;
  showHeading?: boolean;
}

interface DialogProps extends AiVisibilitySettingsProps {
  /** Close management and restore its opener's focus. */
  onClose: () => void;
}

/** Searchable provider groups expose only actual advertised model IDs and independent visibility switches. */
export function AiVisibilitySettings({ preferences, onPreferences, advertisedProviders, connections = [], saveFailed, showHeading = true }: AiVisibilitySettingsProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const search = query.trim().toLocaleLowerCase();
  const providers = AI_PROVIDER_IDS.filter((id) => connections.length === 0 || (id !== "openai_compatible" && id !== "anthropic")).map((id) => {
    const label = id === "openai_compatible" ? t("OpenAI 互換 API") : id === "anthropic" ? "Anthropic API" : t(PRESET_LABELS[id] as LabelKey);
    return { id, label, connectionId: undefined, detail: "" };
  });
  const groups = [...providers, ...connections.map((connection) => ({ id: connection.protocol, label: describeApiConnection(connection, t), connectionId: connection.id, detail: connection.model === "" ? connection.endpoint : `${connection.model} • ${connection.endpoint}` }))].map(({ id, label, connectionId, detail }) => {
    const discovery = connectionId ? undefined : advertisedProviders.find((entry) => entry.provider === id);
    const matchProvider = `${label} ${id} ${detail}`.toLocaleLowerCase().includes(search);
    const models = (discovery?.options ?? []).filter((option) => option.category === "model").flatMap((option) => option.options.map((model) => ({ ...model, optionId: option.id }))).filter((model) => matchProvider || `${model.name} ${model.value} ${model.optionId}`.toLocaleLowerCase().includes(search));
    return { id, label, connectionId, detail, discovery, models, matches: matchProvider || models.length > 0 };
  }).filter((group) => group.matches);
  return <section aria-label={t("AI の表示設定")} className="space-y-3 text-xs">
    {showHeading && <h3 className="text-[13px] font-semibold">{t("AI の表示設定")}</h3>}
    <p className="text-muted-foreground">{t("候補を非表示にしても、選択中の接続先とモデルは保持します。")}</p>
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      <label className="flex items-center gap-2"><input type="checkbox" checked={preferences.showProviderSelector} onChange={(event) => onPreferences({ ...preferences, showProviderSelector: event.target.checked })} />{t("チャットに接続先の選択欄を表示")}</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={preferences.showModelSelector} onChange={(event) => onPreferences({ ...preferences, showModelSelector: event.target.checked })} />{t("チャットにモデルの選択欄を表示")}</label>
    </div>
    <input type="search" aria-label={t("接続先とモデルを検索")} placeholder={t("接続先とモデルを検索")} value={query} onChange={(event) => setQuery(event.target.value)} className="w-full rounded-sm border border-border bg-card px-2 py-1.5 text-xs outline-none focus:border-primary" />
    <div className="max-h-80 space-y-2 overflow-y-auto">
      {groups.map(({ id, label, connectionId, detail, discovery, models }) => {
        return <fieldset key={connectionId ? `connection:${connectionId}` : `provider:${id}`} className="min-w-0 rounded-sm border border-border p-2">
          <legend className="max-w-full px-1"><label className="flex items-start gap-2 break-words font-medium"><input type="checkbox" className="mt-0.5 shrink-0" aria-label={t("{{provider}} の候補を表示", { provider: label })} checked={isAiProviderVisible(preferences, id, connectionId)} onChange={(event) => onPreferences(connectionId ? setAiConnectionVisible(preferences, connectionId, event.target.checked) : setAiProviderVisible(preferences, id, event.target.checked))} /><ProviderIcon provider={id} /><span className="min-w-0 break-all">{label}</span></label></legend>
          {connectionId && <p className="break-all px-1 py-1 text-[11px] text-muted-foreground">{detail}</p>}
          {models.map((model) => <label key={JSON.stringify([model.optionId, model.value])} className="flex min-w-0 items-start gap-2 rounded-sm px-1 py-1.5 hover:bg-muted">
            <input type="checkbox" className="mt-0.5 shrink-0" aria-label={t("{{model}} を表示", { model: model.name })} checked={isAiModelVisible(preferences, id, model.optionId, model.value)} onChange={(event) => onPreferences(setAiModelVisible(preferences, { provider: id, optionId: model.optionId, value: model.value }, event.target.checked))} />
            <span className="min-w-0"><span className="block break-words">{model.name}</span><span className="block break-all text-[11px] text-muted-foreground">{model.value}</span></span>
          </label>)}
          {models.length === 0 && <p className="px-1 py-1 text-[11px] text-muted-foreground">{id === "openai_compatible" || id === "anthropic" ? t("直接 API のモデル名は接続設定で入力します。") : discovery?.discovered ? t("この接続先はモデル候補を公開していません。CLI の設定を使用します。") : t("この接続先のモデル候補は未取得です。チャットで接続を確認してください。")}</p>}
        </fieldset>;
      })}
      {groups.length === 0 && <p role="status" className="text-muted-foreground">{t("一致する接続先やモデルがありません。")}</p>}
    </div>
    <div className="flex items-center justify-between gap-2"><span>{t("希望するチャット幅")}: {preferences.chatPaneWidth}px</span><button type="button" className="rounded-sm border border-border px-2 py-1 hover:bg-muted" onClick={() => onPreferences({ ...preferences, chatPaneWidth: AI_CHAT_WIDTH.default })}>{t("チャット幅をリセット")}</button></div>
    {saveFailed && <p role="alert">{t("設定を保存できませんでした。この起動中は変更を保持します。")}</p>}
  </section>;
}

/** Reuse the settings node in an accessible management dialog beside either composer. */
export function AiVisibilityDialog({ onClose, ...props }: DialogProps) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDivElement>(null);
  const [host] = useState(() => document.activeElement?.closest("[data-theme]") ?? document.body);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    /** Keep keyboard focus in management and allow Escape to return to the composer. */
    function handleKey(event: KeyboardEvent) {
      trapDialogTab(event, dialog.current);
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    }
    document.addEventListener("keydown", handleKey, true);
    return () => { document.removeEventListener("keydown", handleKey, true); opener?.focus(); };
  }, [onClose]);
  return createPortal(<div className="ai-provider-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div ref={dialog} role="dialog" aria-modal="true" aria-label={t("AI の表示設定")} className="ai-provider-dialog" tabIndex={-1}>
    <div className="flex items-center justify-between border-b border-border px-3 py-2 text-[13px]"><strong>{t("AI の表示設定")}</strong><button type="button" aria-label={t("AI の表示設定を閉じる")} className="rounded-sm px-2 py-1 hover:bg-muted" onClick={onClose}>{t("閉じる")}</button></div>
    <div className="min-h-0 overflow-y-auto p-3"><AiVisibilitySettings {...props} showHeading={false} /></div>
  </div></div>, host);
}
