import { useI18n } from "../i18n/I18nProvider";
// Vim-settings Settings-GUI panel (presentation).
//
// Structured controls (indent, search, leader, mode mappings, copy keys),
// a raw Vimscript editor, and an inspectable managed-block preview with
// fingerprint-guarded saves. State arrives via `useVimSettings`, so this
// component never imports infrastructure directly.
//
// Saving only writes the config file; applying (Neovim restart, Undo reset,
// unsaved text preserved) stays on the existing `applyConfig` flow.

import type { VimMapping } from "../../contracts/vim-settings";
import { VIM_COPY_FORMATS, VIM_MAPPING_MODES, withCopyKey } from "../../domain/vim-settings";
import type { VimSettingsModel } from "./useVimSettings";

/** Props for the Vim settings editor and its optional native file picker. */
export interface VimSettingsPanelProps {
  /** Editor state from `useVimSettings`. */
  model: VimSettingsModel;
  /** Browse for a config file natively, if available. */
  onBrowseConfig?: () => void;
}

const inputClass = "h-8 rounded-sm border border-border bg-card px-2 text-[13px] outline-none focus:border-primary";

/**
 * Render the vim-settings editor: file row, structured controls, preview, raw editor.
 *
 * Structured controls disable on Lua targets and malformed blocks; the raw
 * editor stays available everywhere and every save is fingerprint-guarded.
 */
export function VimSettingsPanel({ model, onBrowseConfig }: VimSettingsPanelProps) {
  const { t } = useI18n();
  const {
    selectedPath,
    setSelectedPath,
    loaded,
    busy,
    settings,
    setSettings,
    rawDraft,
    setRawDraft,
    isLua,
    managedError,
    validation,
    preview,
    previewError,
    changed,
    rawDirty,
    error,
    notice,
    reload,
    saveManaged,
    saveRaw,
  } = model;
  /** Patch one numeric structured option while keeping the draft immutable. */
  const setNumber = (key: "tabstop" | "shiftwidth", value: number) => {
    if (Number.isInteger(value)) setSettings({ ...settings, [key]: value });
  };
  /** Patch one boolean structured option while keeping the draft immutable. */
  const setFlag = (key: "expandtab" | "ignorecase" | "smartcase", value: boolean) => {
    setSettings({ ...settings, [key]: value });
  };
  /** Replace one mapping row while keeping the draft immutable. */
  const setMapping = (index: number, patch: Partial<VimMapping>) => {
    setSettings({
      ...settings,
      mappings: settings.mappings.map((mapping, i) => (i === index ? { ...mapping, ...patch } : mapping)),
    });
  };
  /** Append an empty normal-mode mapping row to the draft. */
  const addMapping = () => {
    setSettings({ ...settings, mappings: [...settings.mappings, { mode: "n", lhs: "", rhs: "" }] });
  };
  /** Remove one mapping row from the draft. */
  const removeMapping = (index: number) => {
    setSettings({ ...settings, mappings: settings.mappings.filter((_, i) => i !== index) });
  };
  const structuredBlocked = loaded === null || isLua || managedError !== null;
  const managedBlocked = structuredBlocked || validation.length > 0 || rawDirty;
  return (
    <div className="space-y-4" aria-label={t("Vim詳細設定")}>
      <div className="space-y-2">
        <p className="text-[13px]">{t("Vim詳細設定ファイル")}</p>
        <div className="flex gap-2">
          <input
            value={selectedPath}
            onChange={(event) => setSelectedPath(event.target.value)}
            placeholder={t("空でMarxen標準設定")}
            aria-label={t("Vim詳細設定ファイルのパス")}
            className={`${inputClass} min-w-0 flex-1`}
          />
          {onBrowseConfig && (
            <button type="button" onClick={onBrowseConfig} aria-label={t("Vim詳細設定ファイルを参照する")} className="shrink-0 rounded-sm border border-border px-3 text-xs hover:bg-muted">
              {t("参照…")}</button>
          )}
          <button type="button" onClick={() => void reload()} disabled={busy} aria-label={t("Vim詳細設定を再読込する")} className="shrink-0 rounded-sm border border-border px-3 text-xs hover:bg-muted disabled:opacity-50">
            {t("再読込")}</button>
        </div>
        {loaded && (
          <p data-testid="vim-settings-status" className="break-all text-xs text-muted-foreground">
            {loaded.exists ? t("読込済み: {{value0}}", { value0: (loaded.path) }) : t("新規作成: {{value0}}", { value0: (loaded.path) })}
            {isLua ? t("（init.lua: 設定コード編集のみ）") : ""}
          </p>
        )}
        {managedError && <p role="alert" className="whitespace-pre-wrap text-xs text-red-500">{managedError}</p>}
      </div>

      <fieldset disabled={busy || structuredBlocked} className="space-y-3 disabled:opacity-60">
        <legend className="mb-1 text-[13px]">{t("インデントと検索")}</legend>
        <label className="flex min-h-10 items-center justify-between gap-4 text-[13px]">
          {t("タブ幅（tabstop）")}<input aria-label={t("タブ幅")} type="number" min={1} max={32} value={settings.tabstop} onChange={(event) => setNumber("tabstop", event.currentTarget.valueAsNumber)} className={`${inputClass} w-20`} />
        </label>
        <label className="flex min-h-10 items-center justify-between gap-4 text-[13px]">
          {t("インデント幅（shiftwidth）")}<input aria-label={t("インデント幅")} type="number" min={1} max={32} value={settings.shiftwidth} onChange={(event) => setNumber("shiftwidth", event.currentTarget.valueAsNumber)} className={`${inputClass} w-20`} />
        </label>
        {(
          [
            ["expandtab", t("スペースでインデントする（expandtab）")],
            ["ignorecase", t("検索で大文字小文字を区別しない（ignorecase）")],
            ["smartcase", t("大文字を含む検索のみ区別する（smartcase）")],
          ] as const
        ).map(([key, text]) => (
          <label key={key} className="flex min-h-10 items-center justify-between gap-4 text-[13px]">
            {text}
            <input aria-label={text} type="checkbox" checked={settings[key]} onChange={(event) => setFlag(key, event.target.checked)} className="h-4 w-4" />
          </label>
        ))}
        <label className="flex min-h-10 items-center justify-between gap-4 text-[13px]">
          {t("リーダーキー")}<input aria-label={t("リーダーキー")} value={settings.leader} maxLength={2} onChange={(event) => setSettings({ ...settings, leader: event.target.value.slice(0, 2) })} className={`${inputClass} w-20 text-center`} />
        </label>
      </fieldset>

      <fieldset disabled={busy || structuredBlocked} className="space-y-3 disabled:opacity-60">
        <legend className="mb-1 text-[13px]">{t("コピー形式キー")}</legend>
        <p className="text-xs leading-5 text-muted-foreground">{t("空で無効。既存のVimマッピングと重複できません。")}</p>
        {VIM_COPY_FORMATS.map((name) => (
          <label key={name} className="flex min-h-10 items-center justify-between gap-4 text-[13px]">
            {`g:marxen_copy_${name}_key`}
            <input
              aria-label={t("コピー形式キー {{value0}}", { value0: (name) })}
              value={(settings.copyKeys as unknown as Record<string, string>)[name] ?? ""}
              onChange={(event) => setSettings(withCopyKey(settings, name, event.target.value))}
              className={`${inputClass} w-28 font-mono`}
            />
          </label>
        ))}
      </fieldset>

      <fieldset disabled={busy || structuredBlocked} className="space-y-2 disabled:opacity-60">
        <legend className="mb-1 text-[13px]">{t("モード別マッピング")}</legend>
        {settings.mappings.length === 0 && <p className="text-xs text-muted-foreground">{t("マッピングはありません。下のボタンで追加します。")}</p>}
        {settings.mappings.map((mapping, index) => (
          <div key={index} className="flex items-center gap-2">
            <select aria-label={t("マッピング{{value0}}のモード", { value0: (index + 1) })} value={mapping.mode} onChange={(event) => setMapping(index, { mode: event.target.value })} className={`${inputClass} w-16`}>
              {VIM_MAPPING_MODES.map((mode) => (
                <option key={mode} value={mode}>{`${mode}noremap`}</option>
              ))}
            </select>
            <input aria-label={t("マッピング{{value0}}のキー", { value0: (index + 1) })} value={mapping.lhs} placeholder="<Leader>w" onChange={(event) => setMapping(index, { lhs: event.target.value })} className={`${inputClass} min-w-0 flex-1 font-mono`} />
            <input aria-label={t("マッピング{{value0}}の内容", { value0: (index + 1) })} value={mapping.rhs} placeholder=":w<CR>" onChange={(event) => setMapping(index, { rhs: event.target.value })} className={`${inputClass} min-w-0 flex-1 font-mono`} />
            <button type="button" onClick={() => removeMapping(index)} aria-label={t("マッピング{{value0}}を削除する", { value0: (index + 1) })} className="shrink-0 rounded-sm border border-border px-2 py-1 text-xs hover:bg-muted">
              {t("削除")}</button>
          </div>
        ))}
        <button type="button" onClick={addMapping} aria-label={t("マッピングを追加する")} className="rounded-sm border border-border px-3 py-1.5 text-xs hover:bg-muted">
          {t("マッピングを追加")}</button>
      </fieldset>

      {validation.length > 0 && (
        <div role="alert" className="space-y-1 rounded-sm border border-red-500/40 p-3">
          {validation.map((detail) => (
            <p key={detail} className="text-xs text-red-500">{detail}</p>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <p className="text-[13px]">{t("変更プレビュー")}</p>
        {previewError && <p role="alert" className="whitespace-pre-wrap text-xs text-red-500">{previewError}</p>}
        {!previewError && preview !== null && (
          <>
            <p data-testid="vim-settings-changed" className="text-xs text-muted-foreground">
              {changed ? t("管理ブロックに変更があります。ブロック外の設定コードは保持します。") : t("変更はありません。")}
            </p>
            <pre data-testid="vim-settings-preview" className="max-h-56 overflow-auto whitespace-pre-wrap rounded-sm bg-card p-3 font-mono text-xs leading-5">{preview}</pre>
          </>
        )}
        {rawDirty && <p className="text-xs text-muted-foreground">{t("設定コードに未保存の編集があります。管理保存は読込時の設定コードに適用します。設定コードの変更は先に設定コード保存してください。")}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void saveManaged()} disabled={busy || managedBlocked} aria-label={t("管理ブロックを保存する")} className="rounded-sm bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50">
            {busy ? t("保存中…") : t("管理ブロックを保存")}
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-[13px]">{t("設定コードエディター")}</p>
        <p className="text-xs leading-5 text-muted-foreground">{t("Vimscript や init.lua の Lua を直接編集できます。保存前に外部変更を確認します。")}</p>
        <textarea
          value={rawDraft}
          onChange={(event) => setRawDraft(event.target.value)}
          aria-label={t("Vim設定ファイルの設定コード")}
          rows={10}
          disabled={busy || !loaded}
          spellCheck={false}
          className="w-full rounded-sm border border-border bg-card p-3 font-mono text-xs leading-5 outline-none focus:border-primary"
        />
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void saveRaw()} disabled={busy || !loaded || !rawDirty} aria-label={t("設定コードを保存する")} className="rounded-sm border border-border px-3 py-2 text-xs hover:bg-muted disabled:opacity-50">
            {busy ? t("保存中…") : t("設定コードを保存")}
          </button>
        </div>
      </div>

      {error && <p role="alert" className="whitespace-pre-wrap text-xs text-red-500">{error}</p>}
      {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
    </div>
  );
}
