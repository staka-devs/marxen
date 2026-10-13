// Vim-settings use case orchestration (application).
//
// Validates structured settings, previews managed rewrites purely, and
// delegates persistence to the injected gateway. No Tauri, DOM, React, or
// browser globals: errors are returned as values or gateway rejections.

import type { VimConfigRead, VimConfigWrite, VimSettings } from "../../contracts/vim-settings";
import {
  defaultVimSettings,
  isLuaConfigPath,
  previewManagedChange,
  validateVimSettings,
} from "../../domain/vim-settings";
import type { VimSettingsGateway } from "./ports";

/**
 * Load a config for editing, falling back to defaults on parse failure.
 *
 * Returns the gateway read verbatim; when `managedError` is set the panel
 * keeps the raw text inspectable and disables managed saving.
 */
export async function loadVimSettings(gateway: VimSettingsGateway, path: string | null): Promise<VimConfigRead> {
  return gateway.read(path);
}

/**
 * Validate structured settings before any native write.
 *
 * Returns validation details (empty when valid) so the panel can block the
 * save without a native round trip.
 */
export function checkVimSettings(settings: VimSettings): string[] {
  return validateVimSettings(settings);
}

/**
 * Preview a managed rewrite of the loaded raw text.
 *
 * Throws the same validation, Lua, and malformed-block errors as saving so
 * the panel inspects exactly what a save would do.
 */
export function previewVimSettings(
  raw: string,
  settings: VimSettings,
  path: string,
): { next: string; changed: boolean } {
  return previewManagedChange(raw, settings, isLuaConfigPath(path));
}

/**
 * Save structured settings through the managed block only.
 *
 * Validates locally first, refuses Lua targets, then delegates to the
 * fingerprint-guarded gateway write. Document buffers are untouched.
 */
export async function saveManagedVimSettings(
  gateway: VimSettingsGateway,
  path: string | null,
  expectedFingerprint: string | null,
  settings: VimSettings,
): Promise<VimConfigWrite> {
  const failures = validateVimSettings(settings);
  if (failures.length > 0) throw new Error(failures[0]);
  if (path && isLuaConfigPath(path)) {
    throw new Error("init.lua は原文編集のみです。管理ブロックを挿入しません。");
  }
  return gateway.writeManaged(path, expectedFingerprint, settings);
}

/**
 * Save caller-edited raw text verbatim with a stale-file guard.
 *
 * No reinterpretation happens here; size and encoding checks live natively.
 */
export async function saveRawVimSettings(
  gateway: VimSettingsGateway,
  path: string | null,
  expectedFingerprint: string | null,
  raw: string,
): Promise<VimConfigWrite> {
  return gateway.writeRaw(path, expectedFingerprint, raw);
}

/**
 * Fresh defaults for a config that has no managed block yet.
 *
 * Returns a copy so panel edits never share mutable state.
 */
export function freshVimSettings(read: VimConfigRead): VimSettings {
  return read.managedError ? defaultVimSettings() : read.settings;
}
