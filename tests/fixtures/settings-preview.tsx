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
import AiProviderSettings from "../../src/presentation/ai-provider-settings";
import type { ApiConnectionControls } from "../../src/presentation/ai/ApiConnections";
import { aiProfileStore } from "../../src/infrastructure/storage/ai-profile-store";
import { loadApiConnections, saveApiConnections } from "../../src/infrastructure/storage/api-connections-store";
import { buildProviderConfigFromConnection, resolveProviderChange } from "../../src/domain/ai-connections";
import { mintConnectionId } from "../../src/presentation/ai/connection-id";
import { defaultProviderConfig } from "../../src/domain/ai-config";
import type { AiProviderConfig, ApiConnection, ApiConnectionId } from "../../src/contracts/ai-contracts";
import { NotificationToast, type Notice } from "../../src/presentation/workspace/Notifications";
import { VimSettingsPanel } from "../../src/presentation/vim-settings/VimSettingsPanel";
import { useVimSettings } from "../../src/presentation/vim-settings/useVimSettings";
import "../../src/styles.css";
import "../../src/presentation/ai-chat.css";

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
  const [connections, setConnections] = useState(loadApiConnections);
  /**
   * Start the fixture provider from the active named connection when present.
   *
   * Mirrors the shell restore so reload proves the selected connection returns
   * instead of a stale default; ACP stays the fallback with no selection.
   */
  const [provider, setProviderState] = useState<AiProviderConfig>(() => {
    const list = loadApiConnections();
    const active = list.connections.find((item) => item.id === list.activeId) ?? null;
    return active ? buildProviderConfigFromConnection(active) : defaultProviderConfig("acp");
  });
  /**
   * Persist the connection list in the fixture's localStorage without native calls.
   *
   * Mirrors the shell's persistence so reload proves restart restoration.
   */
  function persist(list: typeof connections) {
    setConnections(list);
    saveApiConnections(list);
  }
  /**
   * Replace the fixture provider through the shared pure identity resolver.
   *
   * ACP selections clear the named marker while ID-carrying API configs switch
   * to the saved record; missing IDs keep the previous selection. Persistence
   * runs before state changes so reload proves the stored outcome.
   */
  function handleProvider(next: AiProviderConfig) {
    const decision = resolveProviderChange(connections, next);
    if (decision.missing || decision.provider === null) return;
    if (decision.persist !== null) persist(decision.persist);
    setProviderState(decision.provider);
  }
  /** Named-connection controls for the fixture settings without native credentials. */
  const connectionControls: ApiConnectionControls = {
    list: connections,
    activeId: connections.activeId,
    /** Switch the fixture chat to one named connection wholesale. */
    onSelect: (id: ApiConnectionId) => {
      const connection = connections.connections.find((item) => item.id === id) ?? null;
      if (!connection) return false;
      persist({ ...connections, activeId: connection.id });
      setProviderState(buildProviderConfigFromConnection(connection));
      return true;
    },
    /** Register a fixture connection without storing any secret. */
    onAdd: (connection: ApiConnection) => {
      persist({ ...connections, activeId: connection.id, connections: [...connections.connections, connection] });
      setProviderState(buildProviderConfigFromConnection(connection));
      return true;
    },
    /** Persist fixture edits, refreshing the provider when active. */
    onUpdate: (connection: ApiConnection) => {
      const list = { ...connections, connections: connections.connections.map((item) => (item.id === connection.id ? connection : item)) };
      persist(list);
      if (list.activeId === connection.id) setProviderState(buildProviderConfigFromConnection(connection));
      return true;
    },
    /** Delete a fixture connection without touching any credential store. */
    onDelete: (id: ApiConnectionId) => {
      const remaining = connections.connections.filter((item) => item.id !== id);
      const activeId = connections.activeId === id ? (remaining[0]?.id ?? null) : connections.activeId;
      persist({ ...connections, activeId, connections: remaining });
      const next = remaining.find((item) => item.id === activeId) ?? null;
      if (connections.activeId === id) setProviderState(next ? buildProviderConfigFromConnection(next) : defaultProviderConfig("acp"));
      return true;
    },
    /** Mint a fresh fixture ID outside render. */
    onMintId: () => mintConnectionId(connections.connections.map((item) => item.id)) as ApiConnectionId,
  };
  return <div data-theme={preferences.theme} style={{ minHeight: "100dvh" }} className="bg-background p-4 text-foreground">
    <p className="mb-4 text-sm">Mocked settings fixture — no native Neovim</p>
    <div className="mb-4 flex flex-wrap gap-3">
      <button onClick={() => setSettingsOpen(true)}>Open settings</button>
      <button onClick={() => setNotice({ id: Date.now(), kind: "info", message: "保存しました。" })}>Info</button>
      <button onClick={() => setNotice({ id: Date.now(), kind: "error", message: "保存できませんでした。" })}>Error</button>
      <button onClick={() => setRecovery(true)}>Recovery</button>
    </div>
    <textarea aria-label="Fixture editor" defaultValue="Editor focus and layout must stay unchanged." className="h-40 w-full border border-border bg-card p-4" />
    {settingsOpen && <SettingsPanel theme={preferences.theme} onTheme={(theme) => { const next = { ...preferences, theme }; setPreferences(next); saveEditorPreferences(next); }} preferences={preferences} onPreferences={(next) => { setPreferences(next); saveEditorPreferences(next); }} configPath="/mock/.vimrc" configError={null} onConfigPath={() => {}} onApplyConfig={() => {}} applyingConfig={false} currentConfig="/mock/.vimrc" onClose={() => setSettingsOpen(false)} vimSettings={<VimSettingsPanel model={model} />} aiSettings={<AiProviderSettings embedded provider={provider} onProvider={handleProvider} profileStore={aiProfileStore} connectionControls={connectionControls} />} aiVisibilitySettings={<p>AI visibility slot</p>} />}
    {notice && <NotificationToast notice={notice} onDismiss={() => setNotice(null)} position={preferences.notificationPosition} theme={preferences.theme} />}
    {recovery && <NotificationToast notice={{ id: 7, kind: "info", message: "未保存の文書を復元" }} testId="recovery-toast" onDismiss={() => setRecovery(false)} raised={notice !== null} position={preferences.notificationPosition} theme={preferences.theme} actions={<button>Restore</button>} />}
  </div>;
}

const requested = new URL(window.location.href).searchParams.get("language");
const language = requested === "en-US" || requested === "ja-JP-x-kansai" || requested === "ja-JP-x-tokushima" ? requested : "ja-JP";
document.documentElement.lang = language.startsWith("en") ? "en" : "ja";
createRoot(document.getElementById("root")!).render(<I18nProvider language={language} createTranslator={createTranslator}><Fixture /></I18nProvider>);
