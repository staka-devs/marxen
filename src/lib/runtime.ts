import { invoke, isTauri } from "@tauri-apps/api/core";
import type { RuntimeStatus } from "../shared/contracts";

export async function readRuntimeStatus(): Promise<RuntimeStatus> {
  if (!isTauri()) {
    return { contractVersion: 1, connection: "disconnected", detail: "ブラウザ表示です。デスクトップの Neovim には接続していません。" };
  }
  return invoke<RuntimeStatus>("get_runtime_status");
}
