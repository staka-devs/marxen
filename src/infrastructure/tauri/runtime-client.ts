// Tauri runtime transport (infrastructure).
//
// Native Neovim connectivity status. No React or DOM rendering: the shell
// polls this through the runtime gateway injected by the composition root.

import { invoke, isTauri } from "@tauri-apps/api/core";
import type { RuntimeStatus } from "../../contracts/contracts";

/**
 * Read the native runtime status, or disconnected in the browser demo.
 *
 * The browser never connects to Neovim; desktop delegates to `get_runtime_status`.
 */
export async function readRuntimeStatus(): Promise<RuntimeStatus> {
  if (!isTauri()) {
    return { contractVersion: 1, connection: "disconnected", detail: "ブラウザ表示です。デスクトップの Neovim には接続していません。" };
  }
  return invoke<RuntimeStatus>("get_runtime_status");
}
