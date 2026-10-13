// Native file pickers via @tauri-apps/plugin-dialog.
//
// Desktop only: folder selection and Neovim config-file selection use the
// OS dialog. The typed manual path inputs stay available alongside the
// picker buttons. Outside Tauri (browser demo, Vitest jsdom) these helpers
// resolve null and the shell keeps its manual inputs.

import { isDesktop } from "./workspace";

/** Native folder picker; null when cancelled or unavailable. */
export async function pickFolder(): Promise<string | null> {
  if (!isDesktop()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false, title: "フォルダーを開く" });
  return typeof selected === "string" ? selected : null;
}

/** Native config-file picker; the name is validated by the caller. */
export async function pickConfigFile(): Promise<string | null> {
  if (!isDesktop()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: false, multiple: false, title: "Neovim 設定ファイルを選ぶ" });
  return typeof selected === "string" ? selected : null;
}
