// Native file-drop subscription (infrastructure).
//
// The real Neovim buffer stays authoritative: this only reports dropped native
// paths with their window position so the shell routes them through the
// registry. No React or DOM rendering.

import { getCurrentWebview } from "@tauri-apps/api/webview";

/** Window position of a native drop in physical pixels. */
export interface NativeDropPosition {
  x: number;
  y: number;
}

/** Native drop payload with window position and absolute paths. */
export interface NativeDrop {
  position: NativeDropPosition;
  paths: string[];
}

/** Unsubscribe function for a native drop subscription. */
export type NativeDropUnlisten = () => void;

/**
 * Subscribe to native drag-drop events, reporting only completed drops.
 *
 * Hover and cancelled payloads are ignored; the caller converts positions
 * with `devicePixelRatio` and routes paths through the registry.
 */
export function listenNativeDrop(onDrop: (drop: NativeDrop) => void): Promise<NativeDropUnlisten> {
  return getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type !== "drop") return;
    onDrop({ position: event.payload.position, paths: event.payload.paths });
  });
}
