import { THEMES, isSupportedConfigName, type ThemeId } from "../../lib/workspace";

interface Props {
  theme: ThemeId;
  onTheme: (theme: ThemeId) => void;
  configPath: string;
  configError: string | null;
  onConfigPath: (path: string) => void;
  onClose: () => void;
}

export function SettingsPanel({ theme, onTheme, configPath, configError, onConfigPath, onClose }: Props) {
  return (
    <div data-testid="settings" role="dialog" aria-label="設定" className="absolute inset-x-0 top-12 z-20 mx-auto max-w-lg rounded-lg border border-border bg-card p-5 shadow-lg">
      <h2 className="text-base font-semibold">設定</h2>
      <section aria-label="テーマ" className="mt-4">
        <p className="mb-2 text-sm font-medium">テーマ</p>
        <div className="flex gap-2">
          {THEMES.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onTheme(item.id)}
              aria-pressed={theme === item.id}
              className={`rounded-md border px-3 py-2 text-sm ${theme === item.id ? "border-primary bg-muted font-medium" : "border-border"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </section>
      <section aria-label="Neovim 設定" className="mt-5">
        <p className="mb-2 text-sm font-medium">Neovim 設定ファイル</p>
        <p className="mb-2 text-xs text-muted-foreground">既定は専用設定（隔離）。vimrc / _vimrc / init.vim / init.lua を選択できます。</p>
        <input
          value={configPath}
          onChange={(event) => onConfigPath(event.target.value)}
          placeholder="未指定（専用設定）"
          aria-label="Neovim 設定ファイルのパス"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
        {configPath !== "" && !isSupportedConfigName(configPath) && (
          <p role="alert" className="mt-2 text-xs text-red-700">
            対応する名前は vimrc / _vimrc / init.vim / init.lua です。
          </p>
        )}
        {configError && (
          <p role="alert" className="mt-2 text-xs text-red-700">
            {configError}
          </p>
        )}
      </section>
      <button type="button" onClick={onClose} className="mt-5 w-full rounded-md border border-border px-3 py-2 text-sm">
        閉じる
      </button>
    </div>
  );
}
