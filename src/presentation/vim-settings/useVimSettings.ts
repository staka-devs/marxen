// Vim-settings editor state over the application use case (presentation).
//
// Owns the selected config path, the loaded fingerprint-guarded file, the
// structured draft, the raw draft, and pure previews. All native access
// arrives via the injected gateway, so this hook never imports
// infrastructure directly.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VimConfigRead, VimSettings } from "../../contracts/vim-settings";
import type { VimSettingsGateway } from "../../application/vim-settings/ports";
import {
  loadVimSettings,
  previewVimSettings,
  saveManagedVimSettings,
  saveRawVimSettings,
} from "../../application/vim-settings/vim-settings-service";
import { defaultVimSettings, validateVimSettings } from "../../domain/vim-settings";

/** Injected gateway and initial path for the vim-settings editor. */
export interface VimSettingsArgs {
  /** Native gateway for fingerprint-guarded config reads and writes. */
  gateway: VimSettingsGateway;
  /** Explicit config path, or null/empty for the app-specific standard config. */
  initialPath?: string | null;
  /** Called with the saved path so the shell can offer a config apply. */
  onSaved?: (path: string) => void;
}

/** Editable vim-settings state and operations for the panel. */
export interface VimSettingsModel {
  /** Explicit config path input; empty selects the app standard config. */
  selectedPath: string;
  /** Replace the selected config path input. */
  setSelectedPath: (path: string) => void;
  /** Last loaded file state, or null before the first load. */
  loaded: VimConfigRead | null;
  /** Whether a native read or write is in flight. */
  busy: boolean;
  /** Structured draft edited through the GUI controls. */
  settings: VimSettings;
  /** Replace the structured draft wholesale. */
  setSettings: (settings: VimSettings) => void;
  /** Raw file draft edited through the raw editor. */
  rawDraft: string;
  /** Replace the raw file draft. */
  setRawDraft: (raw: string) => void;
  /** Whether the loaded file is Lua raw-only. */
  isLua: boolean;
  /** Managed-block parse failure from the last load, if any. */
  managedError: string | null;
  /** Structured validation details for the current draft. */
  validation: string[];
  /** Rewritten file preview, or null when the preview itself fails. */
  preview: string | null;
  /** Preview failure detail, if any. */
  previewError: string | null;
  /** Whether the preview differs from the loaded raw text. */
  changed: boolean;
  /** Whether the raw draft has unsaved edits against the loaded text. */
  rawDirty: boolean;
  /** Last native or validation failure surfaced to the panel. */
  error: string | null;
  /** Last success notice surfaced to the panel. */
  notice: string | null;
  /** Reload the selected config through the gateway. */
  reload: () => Promise<void>;
  /** Save the structured draft through the managed block. */
  saveManaged: () => Promise<void>;
  /** Save the raw draft verbatim. */
  saveRaw: () => Promise<void>;
}

/**
 * Own the vim-settings editor: path, guarded file, drafts, and previews.
 *
 * Loads on mount and on path change; drafts reset from every load so the
 * fingerprint always matches the displayed text. Document buffers are never
 * touched here, so unsaved text survives saves and applies.
 */
export function useVimSettings(args: VimSettingsArgs): VimSettingsModel {
  const { gateway, initialPath = null, onSaved } = args;
  const [selectedPath, changeSelectedPath] = useState(initialPath ?? "");
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;
  const operation = useRef(0);
  const writing = useRef(false);
  const loadedFor = useRef<string | null>(null);
  const [loaded, setLoaded] = useState<VimConfigRead | null>(null);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<VimSettings>(defaultVimSettings());
  const [rawDraft, setRawDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Latest gateway without retriggering the load effect on identity change. */
  const gatewayRef = useRef(gateway);
  gatewayRef.current = gateway;
  /** Latest save notice without retriggering the save callbacks. */
  const savedRef = useRef(onSaved);
  savedRef.current = onSaved;

  /** Invalidate pending reads immediately when selecting another config file. */
  const setSelectedPath = useCallback((path: string) => {
    if (writing.current || path === selectedPathRef.current) return;
    selectedPathRef.current = path;
    operation.current += 1;
    loadedFor.current = null;
    setLoaded(null);
    setError(null);
    setNotice(null);
    changeSelectedPath(path);
  }, []);

  /** Reload the selected config through the gateway. */
  const reload = useCallback(async () => {
    if (writing.current) return;
    const token = ++operation.current;
    loadedFor.current = null;
    setLoaded(null);
    setBusy(true);
    setError(null);
    try {
      const read = await loadVimSettings(gatewayRef.current, selectedPath === "" ? null : selectedPath);
      if (token !== operation.current) return;
      loadedFor.current = selectedPath;
      setLoaded(read);
      setSettings(read.managedError ? defaultVimSettings() : read.settings);
      setRawDraft(read.raw);
      setNotice(read.exists ? null : "設定ファイルはまだありません。保存すると新規作成します。");
    } catch (cause) {
      if (token === operation.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (token === operation.current) setBusy(false);
    }
  }, [selectedPath]);

  useEffect(() => {
    void reload();
    return () => { operation.current += 1; };
  }, [reload]);

  /** Save the structured draft through the managed block. */
  const saveManaged = useCallback(async () => {
    if (writing.current || busy || !loaded || loadedFor.current !== selectedPath) return;
    if (rawDraft !== loaded.raw) {
      setError("設定コードに未保存の変更があります。先に設定コードを保存してください。");
      return;
    }
    writing.current = true;
    const token = ++operation.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const path = selectedPath === "" ? null : selectedPath;
      const written = await saveManagedVimSettings(
        gatewayRef.current,
        path,
        loaded?.fingerprint ?? null,
        settings,
      );
      const read = await loadVimSettings(gatewayRef.current, path);
      if (token !== operation.current) return;
      setLoaded(read);
      setSettings(read.managedError ? defaultVimSettings() : read.settings);
      setRawDraft(read.raw);
      setNotice("管理ブロックを保存しました。設定の適用でNeovimを再起動します。");
      savedRef.current?.(written.path);
    } catch (cause) {
      if (token === operation.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      writing.current = false;
      if (token === operation.current) setBusy(false);
    }
  }, [selectedPath, loaded, settings, busy, rawDraft]);

  /** Save the raw draft verbatim. */
  const saveRaw = useCallback(async () => {
    if (writing.current || busy || !loaded || loadedFor.current !== selectedPath) return;
    writing.current = true;
    const token = ++operation.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const path = selectedPath === "" ? null : selectedPath;
      const written = await saveRawVimSettings(gatewayRef.current, path, loaded?.fingerprint ?? null, rawDraft);
      const read = await loadVimSettings(gatewayRef.current, path);
      if (token !== operation.current) return;
      setLoaded(read);
      setSettings(read.managedError ? defaultVimSettings() : read.settings);
      setRawDraft(read.raw);
      setNotice("設定コードを保存しました。設定の適用でNeovimを再起動します。");
      savedRef.current?.(written.path);
    } catch (cause) {
      if (token === operation.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      writing.current = false;
      if (token === operation.current) setBusy(false);
    }
  }, [selectedPath, loaded, rawDraft, busy]);

  /** Structured validation details for the current draft. */
  const validation = useMemo(() => validateVimSettings(settings), [settings]);
  /** Whether the loaded file is Lua raw-only. */
  const isLua = loaded?.isLua ?? false;
  /** Managed-block parse failure from the last load, if any. */
  const managedError = loaded?.managedError ?? null;
  const previewed = useMemo(() => {
    if (!loaded) return { preview: null as string | null, previewError: null as string | null, changed: false };
    try {
      const { next, changed } = previewVimSettings(loaded.raw, settings, loaded.path);
      return { preview: next, previewError: null as string | null, changed };
    } catch (cause) {
      return {
        preview: null as string | null,
        previewError: cause instanceof Error ? cause.message : String(cause),
        changed: false,
      };
    }
  }, [loaded, settings]);

  return {
    selectedPath,
    setSelectedPath,
    loaded,
    busy,
    settings,
    setSettings,
    rawDraft,
    setRawDraft,
    isLua,
    managedError,
    validation,
    preview: previewed.preview,
    previewError: previewed.previewError,
    changed: previewed.changed,
    rawDirty: loaded ? rawDraft !== loaded.raw : false,
    error,
    notice,
    reload,
    saveManaged,
    saveRaw,
  };
}
