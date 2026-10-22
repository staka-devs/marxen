import { useMemo, useState } from "react";
import { WorkspaceShell } from "./presentation/shell/WorkspaceShell";
import { createComposition } from "./composition";
import { createLanguageService } from "./application/language/language-service";
import { I18nProvider } from "./presentation/i18n/I18nProvider";
import type { LanguagePreference } from "./contracts/language";

/**
 * Root component wiring concrete adapters into the shell via props.
 *
 * Single explicit composition: infrastructure transports are created once
 * here and injected, so presentation never imports them directly.
 */
export default function App() {
  /** Memoized composition so gateways stay stable across renders. */
  const composition = useMemo(() => createComposition(), []);
  const languageService = useMemo(() => createLanguageService(composition.languagePreferenceStore), [composition]);
  const [languageState, setLanguageState] = useState(() => languageService.load(composition.systemLocaleSource.read()));
  /** Persist a language choice and update controls while retaining mounted workspace state. */
  const chooseLanguage = (preference: LanguagePreference) => setLanguageState({ preference, language: languageService.select(preference, composition.systemLocaleSource.read()) });
  return (
    <I18nProvider language={languageState.language} createTranslator={composition.createTranslator}>
      <div lang={languageState.language} className="min-h-screen bg-background text-foreground">
        <h1 className="sr-only">Marxen</h1>
        <WorkspaceShell
        desktop={composition.desktop}
        documentGateway={composition.documentGateway}
        workspaceGateway={composition.workspaceGateway}
        workspaceMetadataStore={composition.workspaceMetadataStore}
        eventSource={composition.eventSource}
        aiGateway={composition.aiGateway}
        aiUsageGateway={composition.aiUsageGateway}
        codexAccountUsageGateway={composition.codexAccountUsageGateway}
        transcriptUsageGateway={composition.transcriptUsageGateway}
        providerAccountGateway={composition.providerAccountGateway}
        isolationGateway={composition.isolationGateway}
        runtimeGateway={composition.runtimeGateway}
        dialogGateway={composition.dialogGateway}
        dropGateway={composition.dropGateway}
        clipboardGateway={composition.clipboardGateway}
        aiProfileStore={composition.aiProfileStore}
        chatHistoryStore={composition.chatHistoryStore}
        apiConnectionStore={composition.apiConnectionStore}
        apiConnectionGateway={composition.apiConnectionGateway}
        aiViewPreferencesStore={composition.aiViewPreferencesStore}
        editorPreferencesStore={composition.editorPreferencesStore}
        imageLoader={composition.imageLoader}
        vimSettingsGateway={composition.vimSettingsGateway}
        languagePreference={languageState.preference}
        onLanguagePreference={chooseLanguage}
      />
      </div>
    </I18nProvider>
  );
}
