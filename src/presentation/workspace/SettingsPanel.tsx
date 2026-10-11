import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bot, Clipboard, Code2, Paintbrush, Search, Settings2, SlidersHorizontal, X, RotateCcw } from "lucide-react";
import { THEMES, isSupportedConfigName, type ThemeId } from "../../domain/workspace-content";
import { COPY_LABELS } from "../../domain/clipboard-text";
import { DEFAULT_EDITOR_PREFERENCES, type EditorPreferences } from "../../domain/editor-preferences";

interface Props {
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
  /** Close the settings dialog. */
  onClose: () => void;
}
const CATEGORIES = [
  { id: "appearance", label: "外観", icon: Paintbrush, search: "テーマ カラー 色 ライト ダーク ハイコントラスト theme appearance" },
  { id: "editor", label: "エディター", icon: SlidersHorizontal, search: "文字サイズ フォント 行の高さ 折り返す 行番号 編集中 強調 editor font wrap" },
  { id: "vim", label: "Vim", icon: Code2, search: "Neovim 設定ファイル vimrc _vimrc .vimrc init.vim init.lua パス 再起動" },
  { id: "copy", label: "コピー", icon: Clipboard, search: "ヤンク 形式 キー リッチテキスト 画像 Markdown HTML F6 F7 F8 F9 clipboard yank" },
  { id: "ai", label: "AI", icon: Bot, search: "Agent エージェント 接続 API Codex OpenCode ACP Anthropic OpenAI endpoint model 資格情報" },
] as const;
type Category = typeof CATEGORIES[number]["id"];
const inputClass = "h-8 rounded-sm border border-border bg-card px-2 text-[13px] outline-none focus:border-primary";

/** Label an immediately applied setting and align its control consistently. */
function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return <label className="flex min-h-10 items-center justify-between gap-4 text-[13px]">{label}<span className="flex shrink-0 items-center gap-2">{children}</span></label>;
}

/** Searchable settings with shared AI fields, immediate preferences and a trapped dialog focus. */
export function SettingsPanel({ theme, onTheme, preferences = DEFAULT_EDITOR_PREFERENCES, onPreferences, configPath, configError, onConfigPath, onBrowseConfig, onApplyConfig, applyingConfig, currentConfig, copyKeys, aiSettings, onClose }: Props) {
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
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = CATEGORIES.filter((item) => terms.every((term) => `${item.label} ${item.search}`.toLocaleLowerCase().includes(term)));
  const visible = terms.length > 0 ? matches : CATEGORIES.filter((item) => category === "all" || category === item.id);
  const nameInvalid = configPath !== "" && !isSupportedConfigName(configPath);
  return <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} tabIndex={-1} data-testid="settings" role="dialog" aria-modal="true" aria-label="設定" className="flex h-[min(720px,85dvh)] w-[min(860px,95vw)] flex-col overflow-hidden rounded-sm border border-border bg-background shadow-2xl outline-none"
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); onClose(); }
        if (event.key === "Tab") {
          const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, a[href]') ?? []).filter((item) => item.getClientRects().length > 0);
          const first = items[0], last = items.at(-1);
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
        <Settings2 size={16} className="text-muted-foreground" aria-hidden="true" /><h2 className="flex-1 text-sm font-medium">設定</h2>
        <span className="text-[11px] text-muted-foreground max-sm:hidden">表示設定は自動で保存されます</span>
        <button type="button" aria-label="設定を閉じる" onClick={onClose} className="rounded-sm p-1 hover:bg-muted"><X size={17} /></button>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="設定カテゴリ" className="w-40 shrink-0 border-r border-border bg-card py-3 max-sm:w-28">
          {[{ id: "all", label: "すべて", icon: Settings2 }, ...CATEGORIES].map(({ id, label, icon: Icon }) => <button key={id} type="button" onClick={() => { setCategory(id as Category | "all"); setQuery(""); }} aria-current={terms.length === 0 && category === id ? "page" : undefined} className={`flex h-9 w-full items-center gap-2 border-l-2 px-4 text-left text-[13px] ${terms.length === 0 && category === id ? "border-primary bg-muted text-foreground" : "border-transparent text-muted-foreground hover:bg-muted/50"}`}><Icon size={15} className="shrink-0" />{label}</button>)}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-border px-6 py-4">
            <div className="flex h-9 items-center gap-2 rounded-sm border border-border bg-card px-3 focus-within:border-primary"><Search size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" /><input ref={search} type="search" aria-label="設定を検索" placeholder="設定を検索" value={query} onChange={(event) => setQuery(event.target.value)} className="marxen-settings-search min-w-0 flex-1 bg-transparent text-[13px] outline-none" />{query && <button type="button" aria-label="検索をクリア" onClick={() => { setQuery(""); search.current?.focus(); }} className="rounded-sm p-1 hover:bg-muted"><X size={13} /></button>}</div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
            {visible.length === 0 && <p role="status" className="py-8 text-sm text-muted-foreground">一致する設定がありません。</p>}
            {visible.map(({ id, label }) => <section key={id} aria-label={`${label}設定`} className="border-b border-border py-5 last:border-b-0">
              <h3 className="mb-3 text-sm font-semibold">{label}</h3>
              {id === "appearance" && <>
                <SettingRow label="カラーテーマ"><select aria-label="カラーテーマ" className={`${inputClass} w-40`} value={theme} onChange={(event) => onTheme(event.target.value as ThemeId)}>{THEMES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></SettingRow>
                <div className="mt-2 rounded-sm border border-border bg-card px-3 py-3" style={{ fontSize: preferences.fontSize, lineHeight: preferences.lineHeight }}><p>日本語のメモと Markdown</p><code className="text-muted-foreground">const message = "Hello, Marxen";</code></div>
              </>}
              {id === "editor" && <>
                <SettingRow label="文字サイズ"><input aria-label="文字サイズ" type="number" min={11} max={28} value={preferences.fontSize} onChange={(event) => { const n = event.currentTarget.valueAsNumber; if (Number.isFinite(n)) change("fontSize", Math.min(28, Math.max(11, n))); }} className={`${inputClass} w-20`} /><span className="text-xs text-muted-foreground">px</span></SettingRow>
                <SettingRow label="行の高さ"><select aria-label="行の高さ" value={preferences.lineHeight} onChange={(event) => change("lineHeight", Number(event.target.value))} className={`${inputClass} w-24`}>{[1.2, 1.4, 1.5, 1.6, 1.7, 1.8, 2, 2.2, 2.4].map((height) => <option key={height} value={height}>{height}</option>)}</select></SettingRow>
                {([["wordWrap", "長い行を折り返す"], ["lineNumbers", "Markdown の行番号を表示する"], ["highlightActiveLine", "編集中の行を強調する"]] as const).map(([key, text]) => <SettingRow key={key} label={text}><input aria-label={text} type="checkbox" checked={preferences[key]} onChange={(event) => change(key, event.target.checked)} className="h-4 w-4" /></SettingRow>)}
                <button type="button" onClick={() => onPreferences?.({ ...DEFAULT_EDITOR_PREFERENCES, theme })} className="mt-3 flex items-center gap-2 rounded-sm border border-border px-3 py-1.5 text-xs hover:bg-muted"><RotateCcw size={13} />エディター設定をリセット</button>
              </>}
              {id === "vim" && <div className="space-y-3">
                <p className="text-[13px]">Neovim 設定ファイル</p><p className="text-xs leading-5 text-muted-foreground">.vimrc、init.vim、init.lua など、普段の設定を読み込めます。</p>
                <div className="flex gap-2"><input value={configPath} onChange={(event) => onConfigPath(event.target.value)} placeholder="設定ファイルのパス" aria-label="Neovim 設定ファイルのパス" className={`${inputClass} min-w-0 flex-1`} />{onBrowseConfig && <button type="button" onClick={onBrowseConfig} aria-label="設定ファイルを参照する" className="shrink-0 rounded-sm border border-border px-3 text-xs hover:bg-muted">参照…</button>}</div>
                {currentConfig !== null && <p data-testid="current-config" className="break-all text-xs text-muted-foreground">使用中: {currentConfig === "" ? "Marxen の標準設定" : currentConfig}</p>}
                {nameInvalid && <p role="alert" className="text-xs text-red-500">vimrc / _vimrc / .vimrc / init.vim / init.lua を指定してください。</p>}{configError && <p role="alert" className="whitespace-pre-wrap text-xs text-red-500">{configError}</p>}
                <button type="button" onClick={onApplyConfig} disabled={applyingConfig || nameInvalid} aria-label="設定を適用して再起動する" className="rounded-sm bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50">{applyingConfig ? "適用中…" : "設定を適用"}</button>
                <p className="text-xs leading-5 text-muted-foreground">Neovim を再起動して適用します。未保存の本文は保持し、Undo 履歴と Vim モードは初期化します。</p>
              </div>}
              {id === "copy" && <div className="space-y-3">
                <p className="text-xs leading-5 text-muted-foreground">yy / yw / 選択して y の直後に形式キーを押します。</p>
                {Object.entries(copyKeys ?? {}).length > 0 ? <div className="divide-y divide-border">{Object.entries(copyKeys!).map(([format, key]) => <div key={format} className="flex items-center justify-between py-2 text-[13px]"><span>{COPY_LABELS[format as keyof typeof COPY_LABELS]}</span><kbd className="rounded-sm border border-border bg-card px-2 py-0.5 font-mono text-xs">{key || "無効"}</kbd></div>)}</div> : <p className="text-xs text-muted-foreground">キー設定はデスクトップで読み込みます。</p>}
                <details><summary className="text-xs text-muted-foreground">vimrc でキーを変更する</summary><pre className="mt-2 overflow-x-auto rounded-sm bg-card p-3 text-xs leading-6">{"let g:marxen_copy_markdown_key = '<F6>'\nlet g:marxen_copy_text_key = '<F7>'\nlet g:marxen_copy_rich_key = '<F8>'\nlet g:marxen_copy_html_key = '<F9>'"}</pre></details>
                <p className="text-xs leading-5 text-muted-foreground">既存の Vim マッピングを優先します。リッチテキストには文書内の相対画像を埋め込みます。</p>
              </div>}
              {id === "ai" && <div className="space-y-4"><p className="text-xs leading-5 text-muted-foreground">Agent チャットとインラインチャットで共通の接続先を使います。</p>{aiSettings ?? <p className="text-xs text-muted-foreground">AI 接続はデスクトップアプリで設定できます。</p>}</div>}
            </section>)}
          </div>
        </div>
      </div>
    </div>
  </div>;
}
