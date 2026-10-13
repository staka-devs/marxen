import type { LabelKey } from "../../contracts/localization";
import { useI18n } from "../i18n/I18nProvider";
import { trapDialogTab } from "./dialogFocus";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bell, Bot, Clipboard, Code2, Paintbrush, Search, Settings2, SlidersHorizontal, X, RotateCcw } from "lucide-react";
import { THEMES, isSupportedConfigName, type ThemeId } from "../../domain/workspace-content";
import { COPY_LABELS } from "../../domain/clipboard-text";
import { DEFAULT_EDITOR_PREFERENCES, NOTIFICATION_POSITIONS, type EditorPreferences } from "../../domain/editor-preferences";
import "../settings-controls.css";

interface Props {
  languagePreference?: import("../../contracts/language").LanguagePreference;
  /** Select a UI language preference supplied by the composition root. */
  onLanguagePreference?: (preference: import("../../contracts/language").LanguagePreference) => void;
  theme: ThemeId;
  /** Apply a color theme choice. */
  onTheme: (theme: ThemeId) => void;
  preferences?: EditorPreferences;
  /** Replace the editor preferences. */
  onPreferences?: (preferences: EditorPreferences) => void;
  configPath: string;
  configError: string | null;
  /** Replace the Neovim config path input. */
  onConfigPath: (path: string) => void;
  /** Browse for a config file natively, if available. */
  onBrowseConfig?: () => void;
  /** Apply the config, restarting the native actor. */
  onApplyConfig: () => void;
  applyingConfig: boolean;
  currentConfig: string | null;
  copyKeys?: Record<string, string>;
  aiSettings?: ReactNode;
  /** AI visibility controls supplied by the composition root. */
  aiVisibilitySettings?: ReactNode;
  /**
   * Optional Vim detail editor (issue-55) rendered below the config apply row.
   *
   * Root wires `VimSettingsHost` here; the panel never imports infrastructure.
   */
  vimSettings?: ReactNode;
  /** Close the settings dialog. */
  onClose: () => void;
}
const CATEGORIES = [
  { id: "appearance", label: "外観", icon: Paintbrush, search: "テーマ カラー 色 ライト ダーク ハイコントラスト theme appearance language locale region 言語 地域" },
  { id: "editor", label: "エディター", icon: SlidersHorizontal, search: "文字サイズ フォント 行の高さ 折り返す 行番号 編集中 強調 editor font wrap" },
  { id: "notifications", label: "通知", icon: Bell, search: "通知 位置 上 下 左 右 中央 notification toast position top bottom left center right" },
  { id: "vim", label: "Vim", icon: Code2, search: "Neovim 設定ファイル vimrc _vimrc .vimrc init.vim init.lua パス 再起動" },
  { id: "copy", label: "コピー", icon: Clipboard, search: "ヤンク 形式 キー リッチテキスト 画像 Markdown HTML F6 F7 F8 F9 clipboard yank" },
  { id: "ai", label: "AI", icon: Bot, search: "Agent エージェント 接続 API Codex OpenCode ACP Anthropic OpenAI endpoint model 資格情報" },
] as const;
type Category = typeof CATEGORIES[number]["id"];
const CATEGORY_FIELDS = {
  appearance: ["言語", "カラーテーマ", "ライト", "ダーク", "ハイコントラスト"],
  editor: ["文字サイズ", "行の高さ", "長い行を折り返す", "Markdown の行番号を表示する", "編集中の行を強調する"],
  notifications: ["通知の表示位置", "左上", "上中央", "右上", "左下", "下中央", "右下"],
  vim: ["Neovim 設定ファイル", "タブ幅", "インデント幅", "リーダーキー", "コピー形式キー", "モード別マッピング", "よく使うリーダーキー", "Space（スペース）"],
  copy: ["装飾なしテキスト", "リッチテキスト", "HTML ソース"],
  ai: ["接続先", "プリセット", "モデル", "API キー", "接続テスト", "資格情報の入力"],
} as const satisfies Record<Category, readonly LabelKey[]>;
const inputClass = "h-9 max-w-full rounded-sm border border-border bg-card px-2 text-[13px] text-foreground outline-none focus:border-primary";
/** Localized labels for the persisted notification anchors. */
const POSITION_LABELS = { "top-left": "左上", "top-center": "上中央", "top-right": "右上", "bottom-left": "左下", "bottom-center": "下中央", "bottom-right": "右下" } as const;

/** Label an immediately applied setting and align its control consistently. */
function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return <label className="marxen-setting-row"><span className="marxen-setting-label">{label}</span><span className="marxen-setting-control">{children}</span></label>;
}

/** Searchable settings with shared AI fields, immediate preferences and a trapped dialog focus. */
export function SettingsPanel({ theme, onTheme, preferences = DEFAULT_EDITOR_PREFERENCES, onPreferences, configPath, configError, onConfigPath, onBrowseConfig, onApplyConfig, applyingConfig, currentConfig, copyKeys, aiSettings, aiVisibilitySettings, vimSettings, onClose, languagePreference = "system", onLanguagePreference }: Props) {
  const { t } = useI18n();
  const [category, setCategory] = useState<Category | "all">("all");
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    search.current?.focus();
    return () => { previous?.focus(); };
  }, []);
  /** Change one view preference while preserving the other values and native editing state. */
  const change = <K extends keyof EditorPreferences>(key: K, value: EditorPreferences[K]) => onPreferences?.({ ...preferences, [key]: value });
  const localizedCategories = CATEGORIES.map((item) => ({ ...item, label: t(item.label as LabelKey), search: `${item.search} ${CATEGORY_FIELDS[item.id].map(key => t(key)).join(" ")}` }));
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = localizedCategories.filter((item) => terms.every((term) => `${item.label} ${item.search}`.toLocaleLowerCase().includes(term)));
  const visible = terms.length > 0 ? matches : localizedCategories.filter((item) => category === "all" || category === item.id);
  const nameInvalid = configPath !== "" && !isSupportedConfigName(configPath);
  return <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-2 sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} tabIndex={-1} data-theme={theme} data-testid="settings" role="dialog" aria-modal="true" aria-label={t("設定")} className="flex h-[min(780px,92dvh)] w-full max-w-[940px] flex-col overflow-hidden rounded-sm border border-border bg-background shadow-2xl outline-none"
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); onClose(); }
        trapDialogTab(event, dialog.current);
      }}>
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
        <Settings2 size={16} className="text-muted-foreground" aria-hidden="true" /><h2 className="flex-1 text-sm font-medium">{t("設定")}</h2>
        <span className="text-[11px] text-muted-foreground max-sm:hidden">{t("表示設定は自動で保存されます")}</span>
        <button type="button" aria-label={t("設定を閉じる")} onClick={onClose} className="rounded-sm p-1 hover:bg-muted"><X size={17} /></button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav aria-label={t("設定カテゴリ")} className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-card p-2 sm:block sm:w-44 sm:overflow-y-auto sm:border-b-0 sm:border-r sm:py-3">
          {[{ id: "all", label: t("すべて"), icon: Settings2 }, ...localizedCategories].map(({ id, label, icon: Icon }) => <button key={id} type="button" onClick={() => { setCategory(id as Category | "all"); setQuery(""); }} aria-current={terms.length === 0 && category === id ? "page" : undefined} className={`flex min-h-9 shrink-0 items-center gap-2 rounded-sm border-l-2 px-3 text-left text-[13px] leading-5 sm:w-full ${terms.length === 0 && category === id ? "border-primary bg-muted text-foreground" : "border-transparent text-muted-foreground hover:bg-muted/50"}`}><Icon size={15} className="shrink-0" aria-hidden="true" />{label}</button>)}
        </nav>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-border bg-background px-4 py-3 sm:px-6">
            <div className="flex h-9 items-center gap-2 rounded-sm border border-border bg-card px-3 focus-within:border-primary"><Search size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" /><input ref={search} type="search" aria-label={t("設定を検索")} placeholder={t("設定を検索")} value={query} onChange={(event) => setQuery(event.target.value)} className="marxen-settings-search min-w-0 flex-1 bg-transparent text-[13px] outline-none" />{query && <button type="button" aria-label={t("検索をクリア")} onClick={() => { setQuery(""); search.current?.focus(); }} className="rounded-sm p-1 hover:bg-muted"><X size={13} /></button>}</div>
          </div>
          <div data-testid="settings-content" className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 sm:px-6">
            {visible.length === 0 && <p role="status" className="py-8 text-sm text-muted-foreground">{t("一致する設定がありません。")}</p>}
            {visible.map(({ id, label }) => <section key={id} aria-label={t("{{value0}}設定", { value0: (label) })} className="marxen-settings-section border-b border-border py-5 last:border-b-0">
              <h3 className="mb-3 text-sm font-semibold">{label}</h3>
              {id === "appearance" && <>
                <SettingRow label={t("言語")}><select aria-label={t("言語")} value={languagePreference} onChange={(event) => onLanguagePreference?.(event.target.value as import("../../contracts/language").LanguagePreference)} className={`${inputClass} w-52`}>
                  <option value="system">{t("システム設定に合わせる")}</option>
                  <option value="en-US">{t("英語 (米国)")}</option>
                  <option value="ja-JP">{t("日本語")}</option>
                  <option value="ja-JP-x-kansai">{t("関西弁 (大阪)")}</option>
                  <option value="ja-JP-x-tokushima">{t("阿波弁 (徳島・鳴門)")}</option>
                </select></SettingRow>
                <p className="text-xs text-muted-foreground">{t("メニューや操作に使う言語を選びます。")}</p>
                <SettingRow label={t("カラーテーマ")}><select aria-label={t("カラーテーマ")} className={`${inputClass} w-40`} value={theme} onChange={(event) => onTheme(event.target.value as ThemeId)}>{THEMES.map((item) => <option key={item.id} value={item.id}>{t(item.label as LabelKey)}</option>)}</select></SettingRow>
              </>}
              {id === "editor" && <>
                <SettingRow label={t("文字サイズ")}><input aria-label={t("文字サイズ")} type="number" min={11} max={28} value={preferences.fontSize} onChange={(event) => { const n = event.currentTarget.valueAsNumber; if (Number.isFinite(n)) change("fontSize", Math.min(28, Math.max(11, n))); }} className={`${inputClass} w-20`} /><span className="text-xs text-muted-foreground">px</span></SettingRow>
                <SettingRow label={t("行の高さ")}><select aria-label={t("行の高さ")} value={preferences.lineHeight} onChange={(event) => change("lineHeight", Number(event.target.value))} className={`${inputClass} w-24`}>{[1.2, 1.4, 1.5, 1.6, 1.7, 1.8, 2, 2.2, 2.4].map((height) => <option key={height} value={height}>{height}</option>)}</select></SettingRow>
                {([["wordWrap", t("長い行を折り返す")], ["lineNumbers", t("Markdown の行番号を表示する")], ["highlightActiveLine", t("編集中の行を強調する")]] as const).map(([key, text]) => <SettingRow key={key} label={text}><input aria-label={text} type="checkbox" checked={preferences[key]} onChange={(event) => change(key, event.target.checked)} className="h-4 w-4" /></SettingRow>)}
                <button type="button" onClick={() => onPreferences?.({ ...DEFAULT_EDITOR_PREFERENCES, theme, notificationPosition: preferences.notificationPosition })} className="mt-3 flex items-center gap-2 rounded-sm border border-border px-3 py-1.5 text-xs hover:bg-muted"><RotateCcw size={13} />{t("エディター設定をリセット")}</button>
              </>}
              {id === "notifications" && <>
                <SettingRow label={t("通知の表示位置")}><select aria-label={t("通知の表示位置")} value={preferences.notificationPosition} onChange={(event) => change("notificationPosition", event.target.value as EditorPreferences["notificationPosition"])} className={`${inputClass} w-52`}>
                  {NOTIFICATION_POSITIONS.map((position) => <option key={position} value={position}>{t(POSITION_LABELS[position])}</option>)}
                </select></SettingRow>
                <p className="text-xs leading-5 text-muted-foreground">{t("保存結果やエラーの通知位置を選びます。本文の配置や入力フォーカスは変わりません。")}</p>
              </>}
              {id === "vim" && <div className="space-y-3">
                <p className="text-[13px]">{t("Neovim 設定ファイル")}</p><p className="text-xs leading-5 text-muted-foreground">{t(".vimrc、init.vim、init.lua など、普段の設定を読み込めます。")}</p>
                <div className="flex gap-2"><input value={configPath} onChange={(event) => onConfigPath(event.target.value)} placeholder={t("設定ファイルのパス")} aria-label={t("Neovim 設定ファイルのパス")} className={`${inputClass} min-w-0 flex-1`} />{onBrowseConfig && <button type="button" onClick={onBrowseConfig} aria-label={t("設定ファイルを参照する")} className="shrink-0 rounded-sm border border-border px-3 text-xs hover:bg-muted">{t("参照…")}</button>}</div>
                {currentConfig !== null && <p data-testid="current-config" className="break-all text-xs text-muted-foreground">{t("使用中:")}{currentConfig === "" ? t("Marxen の標準設定") : currentConfig}</p>}
                {nameInvalid && <p role="alert" className="text-xs text-red-500">{t("vimrc / _vimrc / .vimrc / init.vim / init.lua を指定してください。")}</p>}{configError && <p role="alert" className="whitespace-pre-wrap text-xs text-red-500">{configError}</p>}
                <button type="button" onClick={onApplyConfig} disabled={applyingConfig || nameInvalid} aria-label={t("設定を適用して再起動する")} className="rounded-sm bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50">{applyingConfig ? t("適用中…") : t("設定を適用")}</button>
                <p className="text-xs leading-5 text-muted-foreground">{t("Neovim を再起動して適用します。未保存の本文は保持し、Undo 履歴と Vim モードは初期化します。")}</p>
                {vimSettings}
              </div>}
              {id === "copy" && <div className="space-y-3">
                <p className="text-xs leading-5 text-muted-foreground">{t("yy / yw / 選択して y の直後に形式キーを押します。")}</p>
                {Object.entries(copyKeys ?? {}).length > 0 ? <div className="divide-y divide-border">{Object.entries(copyKeys!).map(([format, key]) => <div key={format} className="flex items-center justify-between py-2 text-[13px]"><span>{t(COPY_LABELS[format as keyof typeof COPY_LABELS] as LabelKey)}</span><kbd className="rounded-sm border border-border bg-card px-2 py-0.5 font-mono text-xs">{key || t("無効")}</kbd></div>)}</div> : <p className="text-xs text-muted-foreground">{t("キー設定はデスクトップで読み込みます。")}</p>}
                <details><summary className="text-xs text-muted-foreground">{t("vimrc でキーを変更する")}</summary><pre className="mt-2 overflow-x-auto rounded-sm bg-card p-3 text-xs leading-6">{"let g:marxen_copy_markdown_key = '<F6>'\nlet g:marxen_copy_text_key = '<F7>'\nlet g:marxen_copy_rich_key = '<F8>'\nlet g:marxen_copy_html_key = '<F9>'"}</pre></details>
                <p className="text-xs leading-5 text-muted-foreground">{t("既存の Vim マッピングを優先します。リッチテキストには文書内の相対画像を埋め込みます。")}</p>
              </div>}
              {id === "ai" && <div className="space-y-4">{aiVisibilitySettings}<p className="text-xs leading-5 text-muted-foreground">{t("Agent チャットとインラインチャットで共通の接続先を使います。")}</p>{aiSettings ?? <p className="text-xs text-muted-foreground">{t("AI 接続はデスクトップアプリで設定できます。")}</p>}</div>}
            </section>)}
          </div>
        </div>
      </div>
    </div>
  </div>;
}
