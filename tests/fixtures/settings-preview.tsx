// Browser proof for production settings and notifications with a mocked Vim gateway.
// No native Neovim, document revisions, OS WebView or IME are exercised here.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { VimSettingsGateway } from "../../src/application/vim-settings/ports";
import { defaultVimSettings, parseManagedBlock, rewriteManagedBlock } from "../../src/domain/vim-settings";
import { loadEditorPreferences, saveEditorPreferences } from "../../src/infrastructure/storage/editor-preferences-store";
import { createTranslator } from "../../src/infrastructure/localization/i18next-translator";
import { I18nProvider } from "../../src/presentation/i18n/I18nProvider";
import { SettingsPanel } from "../../src/presentation/workspace/SettingsPanel";
import { NotificationToast, type Notice } from "../../src/presentation/workspace/Notifications";
import { VimSettingsPanel } from "../../src/presentation/vim-settings/VimSettingsPanel";
import { useVimSettings } from "../../src/presentation/vim-settings/useVimSettings";
import "../../src/styles.css";

let fingerprint = "fixture-1";
let raw = rewriteManagedBlock('" unmanaged 日本語\r\nset number\r\n', {
  ...defaultVimSettings(),
  mappings: [{ mode: "n", lhs: "<Leader>w", rhs: ":w<CR>" }],
}, false);
const gateway: VimSettingsGateway = {
  /** Read the in-memory configuration; no filesystem or Neovim is used. */
  read: async () => ({ path: "/mock/.vimrc", exists: true, isLua: false, raw, fingerprint, settings: parseManagedBlock(raw) ?? defaultVimSettings(), managedError: null }),
  /** Record a guarded mocked managed write using the production pure preview. */
  writeManaged: async (_path, expected, settings) => {
    if (expected !== fingerprint) throw new Error("Mock fingerprint conflict");
    raw = rewriteManagedBlock(raw, settings, false);
    fingerprint += "-next";
    return { path: "/mock/.vimrc", fingerprint, raw };
  },
  /** Record a guarded mocked raw write verbatim. */
  writeRaw: async (_path, expected, next) => {
    if (expected !== fingerprint) throw new Error("Mock fingerprint conflict");
    raw = next; fingerprint += "-raw";
    return { path: "/mock/.vimrc", fingerprint, raw };
  },
};

/** Compose real view components with local preferences and a deliberately mocked Vim gateway. */
function Fixture() {
  const [preferences, setPreferences] = useState(loadEditorPreferences);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [recovery, setRecovery] = useState(false);
  const model = useVimSettings({ gateway });
  return <div data-theme={preferences.theme} style={{ minHeight: "100dvh" }} className="bg-background p-4 text-foreground">
    <p className="mb-4 text-sm">Mocked settings fixture — no native Neovim</p>
    <div className="mb-4 flex flex-wrap gap-3">
      <button onClick={() => setSettingsOpen(true)}>Open settings</button>
      <button onClick={() => setNotice({ id: Date.now(), kind: "info", message: "保存しました。" })}>Info</button>
      <button onClick={() => setNotice({ id: Date.now(), kind: "error", message: "保存できませんでした。" })}>Error</button>
      <button onClick={() => setRecovery(true)}>Recovery</button>
    </div>
    <textarea aria-label="Fixture editor" defaultValue="Editor focus and layout must stay unchanged." className="h-40 w-full border border-border bg-card p-4" />
    {settingsOpen && <SettingsPanel theme={preferences.theme} onTheme={(theme) => { const next = { ...preferences, theme }; setPreferences(next); saveEditorPreferences(next); }} preferences={preferences} onPreferences={(next) => { setPreferences(next); saveEditorPreferences(next); }} configPath="/mock/.vimrc" configError={null} onConfigPath={() => {}} onApplyConfig={() => {}} applyingConfig={false} currentConfig="/mock/.vimrc" onClose={() => setSettingsOpen(false)} vimSettings={<VimSettingsPanel model={model} />} aiVisibilitySettings={<p>AI visibility slot</p>} />}
    {notice && <NotificationToast notice={notice} onDismiss={() => setNotice(null)} position={preferences.notificationPosition} theme={preferences.theme} />}
    {recovery && <NotificationToast notice={{ id: 7, kind: "info", message: "未保存の文書を復元" }} testId="recovery-toast" onDismiss={() => setRecovery(false)} raised={notice !== null} position={preferences.notificationPosition} theme={preferences.theme} actions={<button>Restore</button>} />}
  </div>;
}

const requested = new URL(window.location.href).searchParams.get("language");
const language = requested === "en-US" || requested === "ja-JP-x-kansai" || requested === "ja-JP-x-tokushima" ? requested : "ja-JP";
document.documentElement.lang = language.startsWith("en") ? "en" : "ja";
createRoot(document.getElementById("root")!).render(<I18nProvider language={language} createTranslator={createTranslator}><Fixture /></I18nProvider>);
