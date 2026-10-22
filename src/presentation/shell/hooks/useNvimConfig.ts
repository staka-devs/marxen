// Neovim configuration selection for open documents (presentation, split from useWorkspace for #129).

import { useCallback, useEffect, useState } from "react";
import type { LocalizedText } from "../../../contracts/localization";
import { localizedFailure, renderLocalizedText } from "../../../domain/localization";
import { StaleResync, workspaceErrorText } from "../../../domain/document-errors";
import { isSupportedConfigName } from "../../../domain/workspace-content";
import { useI18n } from "../../i18n/I18nProvider";
import type { DocumentSession } from "./useDocumentSession";

/** Default copy-format selectors before a configuration reports its own. */
const DEFAULT_COPY_KEYS = { markdown: "<F6>", text: "<F7>", rich: "<F8>", html: "<F9>" };

interface Args {
  session: DocumentSession;
  /** Re-read the active configuration whenever settings open. */
  settingsOpen: boolean;
  /** Surface localized configuration outcomes. */
  notify: (notice: LocalizedText | null) => void;
}

/** Selected vimrc path, its errors and copy keys, and applying it to every open document. */
export function useNvimConfig({ session, settingsOpen, notify }: Args) {
  const { t, message } = useI18n();
  const setNotice = notify;
  const { registry, docsRef, activeRef, activeId, mergeSnapshot, sayStale, refreshModeCursor } = session;
  const [configPath, setConfigPath] = useState("");
  const [configError, setConfigError] = useState<LocalizedText | null>(null);
  const [applyingConfig, setApplyingConfig] = useState(false);
  const [currentConfig, setCurrentConfig] = useState<string | null>(null);
  const [copyKeys, setCopyKeys] = useState<Record<string, string>>(DEFAULT_COPY_KEYS);

  /** Apply a Neovim config restarting the actor with Undo reset. */
  const applyConfig = useCallback(async (path?: string) => {
    if (!registry) return;
    const trimmed = (path ?? configPath).trim();
    setConfigPath(trimmed);
    if (trimmed !== "" && !isSupportedConfigName(trimmed)) {
      setConfigError(message("対応する名前は vimrc / _vimrc / .vimrc / init.vim / init.lua です。"));
      return;
    }
    const documents = Object.values(docsRef.current);
    if (!documents.length) return;
    setApplyingConfig(true);
    try {
      for (const current of documents) {
        const id = current.documentId;
        const result = await registry.configure({ ...(current.location ? { location: current.location } : {}), documentId: id, baseRevision: current.revision }, trimmed === "" ? null : trimmed);
        setConfigError(result.errors.length > 0 ? result.errors.join("\n") : null);
        setCurrentConfig(result.path);
        setCopyKeys(result.copyKeys ?? DEFAULT_COPY_KEYS);
        const snapshot = await registry.fetchSnapshot(id);
        mergeSnapshot(snapshot);
        if (activeRef.current === id) await refreshModeCursor(id);
      }
      setNotice(message("設定を適用して再起動しました（Undo・モードは初期化）。"));
    } catch (cause) {
      if (cause instanceof StaleResync) sayStale(cause.snapshot);
      else setNotice(localizedFailure(cause, workspaceErrorText));
    } finally {
      setApplyingConfig(false);
    }
  }, [registry, configPath, mergeSnapshot, refreshModeCursor, sayStale, docsRef, activeRef, notify]);

  useEffect(() => {
    if (!registry || !activeId || !docsRef.current[activeId]) return;
    registry
      .fetchConfig(activeId)
      .then((config) => {
        setCurrentConfig(config.path);
        if (config.path?.startsWith("user:")) setConfigPath(config.path.slice(5));
        setConfigError(config.errors.length > 0 ? config.errors.join("\n") : null);
        setCopyKeys(config.copyKeys ?? DEFAULT_COPY_KEYS);
      })
      .catch(() => undefined);
  }, [settingsOpen, registry, activeId, docsRef]);

  return {
    configPath,
    setConfigPath,
    configError: configError === null ? null : renderLocalizedText(configError, t),
    applyingConfig,
    currentConfig,
    copyKeys,
    applyConfig,
  };
}
