// Native file pickers via the Tauri dialog plugin (infrastructure).
//
// Desktop only: folder selection and Neovim config-file selection use the OS
// dialog. Typed manual path inputs stay available alongside picker buttons.
// Outside Tauri these resolve null and the shell keeps its manual inputs.

import { isDesktop } from "../tauri/workspace-api";
import type { DialogGateway } from "../../application/ports";
import { japaneseMessages } from "../../contracts/localization-messages";

/**
 * Open the native folder picker, returning the selected absolute path.
 *
 * Returns null when cancelled or when running outside Tauri (browser demo,
 * jsdom) so callers fall back to manual inputs.
 */
export async function pickFolder(title: string = japaneseMessages["フォルダーを開く"]): Promise<string | null> {
  if (!isDesktop()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false, title });
  return typeof selected === "string" ? selected : null;
}

/**
 * Open the native config-file picker, returning the selected path.
 *
 * The filename is validated by the caller against supported vimrc names;
 * returns null when cancelled or unavailable.
 */
export async function pickConfigFile(title: string = japaneseMessages["Neovim 設定ファイル"]): Promise<string | null> {
  if (!isDesktop()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: false, multiple: false, title });
  return typeof selected === "string" ? selected : null;
}

const PACK_FILTER = [{ name: "Marxen", extensions: ["marxenpack"] }];

/** Pick a `.marxenpack` to import; null when cancelled or outside Tauri. */
export async function pickPack(title: string): Promise<string | null> {
  if (!isDesktop()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: false, multiple: false, title, filters: PACK_FILTER });
  return typeof selected === "string" ? selected : null;
}

/** Choose where to save an exported `.marxenpack`; null when cancelled or outside Tauri. */
export async function pickPackDestination(title: string, defaultName: string): Promise<string | null> {
  if (!isDesktop()) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return (await save({ title, defaultPath: defaultName, filters: PACK_FILTER })) ?? null;
}

/** Dialog gateway adapter satisfying the application port with native pickers. */
export const dialogGateway: DialogGateway = {
  /** Native folder picker; null when cancelled or unavailable. */
  pickFolder,
  /** Native config-file picker; name validated by the caller. */
  pickConfigFile,
  /** Native `.marxenpack` picker. */
  pickPack,
  /** Native `.marxenpack` save dialog. */
  pickPackDestination,
};
