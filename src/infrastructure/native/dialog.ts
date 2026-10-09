// Native file pickers via the Tauri dialog plugin (infrastructure).
//
// Desktop only: folder selection and Neovim config-file selection use the OS
// dialog. Typed manual path inputs stay available alongside picker buttons.
// Outside Tauri these resolve null and the shell keeps its manual inputs.

import { isDesktop } from "../tauri/workspace-api";
import type { DialogGateway } from "../../application/ports";

/**
 * Open the native folder picker, returning the selected absolute path.
 *
 * Returns null when cancelled or when running outside Tauri (browser demo,
 * jsdom) so callers fall back to manual inputs.
 */
export async function pickFolder(): Promise<string | null> {
  if (!isDesktop()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false, title: "フォルダーを開く" });
  return typeof selected === "string" ? selected : null;
}

/**
 * Open the native config-file picker, returning the selected path.
 *
 * The filename is validated by the caller against supported vimrc names;
 * returns null when cancelled or unavailable.
 */
export async function pickConfigFile(): Promise<string | null> {
  if (!isDesktop()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: false, multiple: false, title: "Neovim 設定ファイルを選ぶ" });
  return typeof selected === "string" ? selected : null;
}

/** Dialog gateway adapter satisfying the application port with native pickers. */
export const dialogGateway: DialogGateway = {
  /** Native folder picker; null when cancelled or unavailable. */
  pickFolder,
  /** Native config-file picker; name validated by the caller. */
  pickConfigFile,
};
