import { useEffect, useRef, useState } from "react";
import { Bot, Clipboard, Code2, Paintbrush, SlidersHorizontal, X, RotateCcw } from "lucide-react";
import { THEMES, isSupportedConfigName, type ThemeId } from "../../lib/workspace";
import { COPY_LABELS } from "../../lib/clipboard";
import { DEFAULT_EDITOR_PREFERENCES, type EditorPreferences } from "../../lib/editor-preferences";

interface Props {
  theme: ThemeId;
  onTheme: (theme: ThemeId) => void;
  preferences?: EditorPreferences;
  onPreferences?: (preferences: EditorPreferences) => void;
  configPath: string;
  configError: string | null;
  onConfigPath: (path: string) => void;
  onBrowseConfig?: () => void;
  onApplyConfig: () => void;
  applyingConfig: boolean;
  currentConfig: string | null;
  copyKeys?: Record<string, string>;
  onOpenAiSettings?: () => void;
  onClose: () => void;
}
const CATEGORIES = [
  { id: "appearance", label: "外観", icon: Paintbrush },
  { id: "editor", label: "エディター", icon: SlidersHorizontal },
  { id: "vim", label: "Vim", icon: Code2 },
  { id: "copy", label: "コピー", icon: Clipboard },
  { id: "ai", label: "AI", icon: Bot },
] as const;
type Category = typeof CATEGORIES[number]["id"];
const inputClass = "rounded border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary";

export function SettingsPanel({ theme, onTheme, preferences = DEFAULT_EDITOR_PREFERENCES, onPreferences, configPath, configError, onConfigPath, onBrowseConfig, onApplyConfig, applyingConfig, currentConfig, copyKeys, onOpenAiSettings, onClose }: Props) {
  const [category, setCategory] = useState<Category>("appearance");
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    return () => { previous?.focus(); };
  }, []);
  const change = <K extends keyof EditorPreferences>(key: K, value: EditorPreferences[K]) => onPreferences?.({ ...preferences, [key]: value });
  const nameInvalid = configPath !== "" && !isSupportedConfigName(configPath);
  return <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/30 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} tabIndex={-1} data-testid="settings" role="dialog" aria-modal="true" aria-label="設定" className="flex h-[min(620px,85vh)] w-[min(800px,95vw)] flex-col overflow-hidden rounded-md border border-border bg-background shadow-2xl outline-none"
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); onClose(); }
        if (event.key === "Tab") {
          const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]') ?? []);
          const first = items[0], last = items.at(-1);
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="text-sm font-semibold">設定</h2><button type="button" aria-label="設定を閉じる" onClick={onClose} className="rounded p-1 hover:bg-muted"><X size={17} /></button>
      </div>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="設定カテゴリ" className="w-40 shrink-0 border-r border-border bg-card px-2 py-3 max-sm:w-28">
          {CATEGORIES.map(({ id, label, icon: Icon }) => <button key={id} type="button" onClick={() => setCategory(id)} aria-current={category === id ? "page" : undefined} className={`mb-1 flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm ${category === id ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"}`}><Icon size={16} className="shrink-0" />{label}</button>)}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
          <h3 className="mb-6 text-lg font-semibold">{CATEGORIES.find((item) => item.id === category)?.label}</h3>
          {category === "appearance" && <section aria-label="テーマ">
            <p className="mb-1 text-sm font-medium">カラーテーマ</p><p className="mb-3 text-xs text-muted-foreground">エディターとすべてのパネルに適用します。</p>
            <div className="grid grid-cols-3 gap-3">{THEMES.map((item) => <button key={item.id} type="button" onClick={() => onTheme(item.id)} aria-pressed={theme === item.id} className={`overflow-hidden rounded border text-left ${theme === item.id ? "border-primary ring-1 ring-primary" : "border-border"}`}>
              <div aria-hidden="true" className="flex h-16 gap-1 p-2" style={{ background: item.id === "dark" ? "#1f1f1f" : "#fff" }}><div className="w-5 rounded-sm" style={{ background: item.id === "dark" ? "#343434" : "#ddd" }} /><div className="flex-1 space-y-2 pt-1">{[75, 50, 65].map((width) => <div key={width} className="h-1 rounded-sm" style={{ width: `${width}%`, background: item.id === "dark" ? "#8a8a8a" : item.id === "contrast" ? "#000" : "#777" }} />)}</div></div><span className="block border-t border-border px-2 py-2 text-xs">{item.label}</span>
            </button>)}</div>
          </section>}
          {category === "editor" && <section aria-label="エディター設定" className="space-y-5">
            <label className="flex items-center justify-between gap-3 text-sm">文字サイズ<div className="flex items-center gap-2"><input aria-label="文字サイズ" type="number" min={11} max={28} value={preferences.fontSize} onChange={(event) => { const n = event.currentTarget.valueAsNumber; if (Number.isFinite(n)) change("fontSize", Math.min(28, Math.max(11, n))); }} className={`${inputClass} w-20`} /><span className="text-xs text-muted-foreground">px</span></div></label>
            <label className="flex items-center justify-between gap-3 text-sm">行の高さ<select aria-label="行の高さ" value={preferences.lineHeight} onChange={(event) => change("lineHeight", Number(event.target.value))} className={`${inputClass} w-24`}>{[1.2, 1.4, 1.5, 1.6, 1.7, 1.8, 2, 2.2, 2.4].map((height) => <option key={height} value={height}>{height}</option>)}</select></label>
            {([ ["wordWrap", "長い行を折り返す"], ["lineNumbers", "行番号を表示する"], ["highlightActiveLine", "編集中の行を強調する"] ] as const).map(([key, label]) => <label key={key} className="flex items-center justify-between gap-3 text-sm">{label}<input aria-label={label} type="checkbox" checked={preferences[key]} onChange={(event) => change(key, event.target.checked)} className="h-4 w-4 accent-[var(--primary)]" /></label>)}
            <p className="text-xs leading-6 text-muted-foreground">変更はすぐに反映され、次回起動時にも保持されます。本文と Vim の Undo 履歴は維持されます。</p>
            <button type="button" onClick={() => onPreferences?.({ ...DEFAULT_EDITOR_PREFERENCES, theme })} className="flex items-center gap-2 rounded border border-border px-3 py-1.5 text-xs hover:bg-muted"><RotateCcw size={13} />エディター設定をリセット</button>
          </section>}
          {category === "vim" && <section aria-label="Neovim 設定" className="space-y-3">
            <p className="text-sm font-medium">Neovim 設定ファイル</p><p className="text-xs leading-6 text-muted-foreground">vimrc / _vimrc / .vimrc / init.vim / init.lua を読み込めます。未指定の場合は Marxen の専用設定を使います。</p>
            {currentConfig !== null && <p data-testid="current-config" className="break-all text-xs text-muted-foreground">現在: {currentConfig === "" ? "専用設定" : currentConfig}</p>}
            <div className="flex gap-2"><input value={configPath} onChange={(event) => onConfigPath(event.target.value)} placeholder="設定ファイルのパス" aria-label="Neovim 設定ファイルのパス" className={`${inputClass} min-w-0 flex-1`} />{onBrowseConfig && <button type="button" onClick={onBrowseConfig} aria-label="設定ファイルを参照する" className="shrink-0 rounded border border-border px-3 text-xs hover:bg-muted">参照…</button>}</div>
            {nameInvalid && <p role="alert" className="text-xs text-red-500">対応する名前は vimrc / _vimrc / .vimrc / init.vim / init.lua です。</p>}{configError && <p role="alert" className="whitespace-pre-wrap text-xs text-red-500">{configError}</p>}
            <button type="button" onClick={onApplyConfig} disabled={applyingConfig || nameInvalid} aria-label="設定を適用して再起動する" className="rounded bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50">{applyingConfig ? "再起動中…" : "設定を適用して再起動する"}</button>
            <p className="text-xs leading-6 text-muted-foreground">適用時に Neovim を再起動します。本文・未保存の変更は保持し、Undo 履歴と Vim のモードは初期化します。</p>
          </section>}
          {category === "copy" && <section aria-label="コピー設定" className="space-y-4">
            <p className="text-sm">ヤンクの直後に形式キーを押すと、選んだ形式でコピーします。</p><div className="divide-y divide-border rounded border border-border">{Object.entries(copyKeys ?? {}).map(([format, key]) => <div key={format} className="flex items-center justify-between px-3 py-3 text-sm"><span>{COPY_LABELS[format as keyof typeof COPY_LABELS]}</span><kbd className="rounded bg-muted px-2 py-0.5 font-mono text-xs">{key || "無効"}</kbd></div>)}</div>
            <p className="text-xs leading-6 text-muted-foreground">yy / yw / 選択して y の後に使用します。既存の Vim マッピングがあるキーは、マッピングを優先します。</p><p className="text-xs leading-6 text-muted-foreground">キーの変更は vimrc に記述します。空文字で個別に無効化できます。</p>
            <pre className="overflow-x-auto rounded bg-muted p-3 text-xs leading-6">{"let g:marxen_copy_markdown_key = '<F6>'\nlet g:marxen_copy_text_key = '<F7>'\nlet g:marxen_copy_rich_key = '<F8>'\nlet g:marxen_copy_html_key = '<F9>'"}</pre><p className="text-xs leading-6 text-muted-foreground">リッチテキストには文書内の相対画像を埋め込みます。外部 URL の画像は参照として渡します。</p>
          </section>}
          {category === "ai" && <section aria-label="AI 設定" className="space-y-4">
            <p className="text-sm">Agent チャットの接続設定で、エージェントや API を選択できます。</p><p className="text-xs leading-6 text-muted-foreground">Codex / OpenCode の ACP 接続、OpenAI 互換 API、Anthropic API に対応します。API キーは OS の資格情報ストアに保存します。</p>
            {onOpenAiSettings && <button type="button" onClick={onOpenAiSettings} className="rounded bg-primary px-3 py-2 text-xs text-primary-foreground">AI の接続設定を開く</button>}
          </section>}
        </div>
      </div>
    </div>
  </div>;
}
