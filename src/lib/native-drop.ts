// Native file-drop subscription behind `lib/` (Issue #14).
//
// `ImageDropZone` previously imported `@tauri-apps/api/webview` directly,
// the only component reaching into the Tauri transport. The real Neovim
// buffer stays authoritative: this only reports dropped native paths with
// their window position so the shell can route them through the registry.

import { getCurrentWebview } from "@tauri-apps/api/webview";

export interface NativeDropPosition {
  x: number;
  y: number;
}

export interface NativeDrop {
  position: NativeDropPosition;
  paths: string[];
}

export type NativeDropUnlisten = () => void;

/** Subscribe to native drag-drop events; resolves to an unlisten function. */
export function listenNativeDrop(onDrop: (drop: NativeDrop) => void): Promise<NativeDropUnlisten> {
  return getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type !== "drop") return;
    onDrop({ position: event.payload.position, paths: event.payload.paths });
  });
}
