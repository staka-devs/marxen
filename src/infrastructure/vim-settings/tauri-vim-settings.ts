import { LocalizedError } from "../../domain/localized-error";
// Tauri vim-settings gateway (infrastructure).
//
// All `vim_settings_*` IPC lives here. No React, no DOM rendering: callers
// go through the application port and the composition root injects this
// gateway, so presentation never imports Tauri directly.

import { invoke, isTauri } from "@tauri-apps/api/core";
import type { VimSettingsGateway } from "../../application/vim-settings/ports";
import type { VimConfigRead, VimConfigWrite, VimSettings } from "../../contracts/vim-settings";

/**
 * Read a config file with its fingerprint and managed parse state.
 *
 * Resolves `null`/empty paths to the app-specific standard config natively;
 * rejects outside Tauri so the browser demo keeps manual inputs only.
 */
async function readVimSettings(path: string | null): Promise<VimConfigRead> {
  if (!isTauri()) throw new LocalizedError("Vim設定ファイルの読込はデスクトップアプリで行います。");
  return invoke<VimConfigRead>("vim_settings_read", { path });
}

/**
 * Rewrite only the managed block through the fingerprint-guarded command.
 *
 * Rejects outside Tauri before any IPC so tests and the demo fail loudly.
 */
async function writeManagedVimSettings(
  path: string | null,
  expectedFingerprint: string | null,
  settings: VimSettings,
): Promise<VimConfigWrite> {
  if (!isTauri()) throw new LocalizedError("Vim設定ファイルの保存はデスクトップアプリで行います。");
  return invoke<VimConfigWrite>("vim_settings_write_managed", {
    path,
    expectedFingerprint,
    settings,
  });
}

/**
 * Store caller-edited raw text verbatim through the guarded command.
 *
 * Rejects outside Tauri before any IPC so callers fall back to notices.
 */
async function writeRawVimSettings(
  path: string | null,
  expectedFingerprint: string | null,
  raw: string,
): Promise<VimConfigWrite> {
  if (!isTauri()) throw new LocalizedError("Vim設定ファイルの保存はデスクトップアプリで行います。");
  return invoke<VimConfigWrite>("vim_settings_write_raw", { path, expectedFingerprint, raw });
}

/** Vim-settings gateway adapter satisfying the application port with Tauri IPC. */
export const vimSettingsGateway: VimSettingsGateway = {
  /** Read a config file with its fingerprint and managed parse state. */
  read: readVimSettings,
  /** Rewrite only the managed block through the fingerprint-guarded command. */
  writeManaged: writeManagedVimSettings,
  /** Store caller-edited raw text verbatim through the guarded command. */
  writeRaw: writeRawVimSettings,
};
