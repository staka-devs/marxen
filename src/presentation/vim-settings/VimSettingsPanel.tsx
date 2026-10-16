import { useI18n } from "../i18n/I18nProvider";
// Vim-settings Settings-GUI panel (presentation).
//
// A plain text Vimscript/Lua editor with fingerprint-guarded saves. State arrives via `useVimSettings`, so this
// component never imports infrastructure directly.
//
// Saving only writes the config file; applying (Neovim restart, Undo reset,
// unsaved text preserved) stays on the existing `applyConfig` flow.

import type { VimSettingsModel } from "./useVimSettings";
import "../settings-controls.css";

/** Props for the Vim settings editor and its optional native file picker. */
export interface VimSettingsPanelProps {
  /** Editor state from `useVimSettings`. */
  model: VimSettingsModel;
  /** Browse for a config file natively, if available. */
  onBrowseConfig?: () => void;
}

const inputClass = "h-9 max-w-full rounded-sm border border-border bg-card px-2 text-[13px] text-foreground outline-none focus:border-primary";
/** Edit the configuration as plain text; Neovim owns Vimscript and Lua semantics. */
export function VimSettingsPanel({ model, onBrowseConfig }: VimSettingsPanelProps) {
  const { t } = useI18n();
  const { selectedPath, setSelectedPath, loaded, busy, rawDraft, setRawDraft, rawDirty, error, notice, reload, saveRaw } = model;
  return (
    <div className="marxen-settings-section space-y-3" aria-label={t("Vim詳細設定")}>
      <div className="flex flex-wrap gap-2">
        <input value={selectedPath} onChange={(event) => setSelectedPath(event.target.value)} placeholder={t("空でMarxen標準設定")} aria-label={t("Vim詳細設定ファイルのパス")} className={`${inputClass} min-w-0 flex-1 basis-48`} />
        {onBrowseConfig && <button type="button" onClick={onBrowseConfig} aria-label={t("Vim詳細設定ファイルを参照する")} className="rounded-sm border border-border px-3 text-xs">{t("参照…")}</button>}
      </div>
      {loaded && <p data-testid="vim-settings-status" className="break-all text-xs text-muted-foreground">{loaded.exists ? t("読込済み: {{value0}}", { value0: loaded.path }) : t("新規作成: {{value0}}", { value0: loaded.path })}</p>}
      <textarea value={rawDraft} onChange={(event) => setRawDraft(event.target.value)} aria-label={t("Vim設定ファイルの設定コード")} rows={16} disabled={busy || !loaded} spellCheck={false} className="w-full rounded-sm border border-border bg-card p-3 font-mono text-xs leading-5 outline-none focus:border-primary" />
      <div className="flex gap-2">
        <button type="button" onClick={() => void reload()} disabled={busy || rawDirty} aria-label={t("Vim詳細設定を再読込する")} className="rounded-sm border border-border px-3 py-2 text-xs disabled:opacity-50">{t("再読込")}</button>
        <button type="button" onClick={() => void saveRaw()} disabled={busy || !loaded || !rawDirty} aria-label={t("設定コードを保存する")} className="rounded-sm bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50">{busy ? t("保存中…") : t("設定コードを保存")}</button>
      </div>
      {error && <p role="alert" className="whitespace-pre-wrap text-xs text-red-500">{error}</p>}
      {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
    </div>
  );
}
