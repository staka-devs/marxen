// Frontend composition root (composition).
//
// Single explicit wiring of concrete infrastructure adapters into
// application ports and presentation. `App` calls this once and injects the
// result into `WorkspaceShell`, so presentation never imports infrastructure
// and domain/application never pull singletons. Adapters that already satisfy
// a port structurally are passed directly with no forwarding wrappers.

import { isDesktop, workspaceApi, workspaceEventSource } from "./infrastructure/tauri/workspace-api";
import { ReadonlyRegistry, RegistryClient } from "./application/document/registry-client";
import { aiGateway, apiConnectionGateway } from "./infrastructure/tauri/ai-client";
import { isolationGateway } from "./infrastructure/tauri/isolation-client";
import { runtimeGateway } from "./infrastructure/tauri/runtime-client";
import { dialogGateway } from "./infrastructure/native/dialog";
import { dropGateway } from "./infrastructure/native/drop";
import { clipboardGateway } from "./infrastructure/clipboard/clipboard-writer";
import { aiProfileStore } from "./infrastructure/storage/ai-profile-store";
import { apiConnectionStore } from "./infrastructure/storage/api-connections-store";
import { createAiViewPreferencesStore } from "./infrastructure/storage/ai-view-preferences-store";
import { editorPreferencesStore } from "./infrastructure/storage/editor-preferences-store";
import { workspaceMetadataStore } from "./infrastructure/storage/workspace-metadata-store";
import { imageLoader } from "./infrastructure/images/image-loader";
import { vimSettingsGateway } from "./infrastructure/vim-settings/tauri-vim-settings";
import { aiUsageGateway, codexAccountUsageGateway } from "./infrastructure/tauri/ai-usage";
import { languagePreferenceStore } from "./infrastructure/storage/language-preference-store";
import { createTranslator } from "./infrastructure/localization/i18next-translator";
import { systemLocaleSource } from "./infrastructure/localization/browser-locale";
import type {
  DocumentGateway,
  DocumentTransport,
  WorkspaceGateway,
} from "./application/ports";

/**
 * Build all injected adapters for the shell in one place.
 *
 * Returns gateways, stores, and flags so `App` stays a thin composer and
 * `WorkspaceShell` receives everything via props.
 */
export function createComposition() {
  const desktop = isDesktop();
  const aiViewPreferencesStore = createAiViewPreferencesStore();
  /** Raw document transport: the Tauri workspace API satisfies the port. */
  const documentTransport: DocumentTransport = workspaceApi;
  /** Serial registry on desktop, rejecting read-only registry in the browser. */
  const documentGateway: DocumentGateway = desktop ? new RegistryClient(documentTransport) : new ReadonlyRegistry();
  /** Workspace file gateway: the Tauri workspace API satisfies the port. */
  const workspaceGateway: WorkspaceGateway = workspaceApi;
  return {
    desktop,
    documentGateway,
    workspaceGateway,
    workspaceMetadataStore,
    eventSource: workspaceEventSource,
    aiGateway,
    aiUsageGateway: desktop ? aiUsageGateway : undefined,
    codexAccountUsageGateway: desktop ? codexAccountUsageGateway : undefined,
    isolationGateway,
    runtimeGateway,
    dialogGateway,
    dropGateway,
    clipboardGateway,
    aiProfileStore,
    apiConnectionStore,
    apiConnectionGateway: desktop ? apiConnectionGateway : undefined,
    aiViewPreferencesStore,
    editorPreferencesStore,
    imageLoader,
    vimSettingsGateway: desktop ? vimSettingsGateway : undefined,
    languagePreferenceStore,
    createTranslator,
    systemLocaleSource,
  };
}

/** Composition result type for shell props and tests. */
export type Composition = ReturnType<typeof createComposition>;
