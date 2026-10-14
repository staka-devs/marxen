import type { WorkspaceFileKind } from "./contracts";

/** Captured tree location in one single-root session; it is not a multi-root IPC contract. */
export interface ExplorerTarget {
  rootId: string;
  generation: number;
  path: string;
  directory: boolean;
  kind?: WorkspaceFileKind;
}

/** Top-level menu membership shared by the workbench's command views. */
export type WorkbenchMenu = "file" | "edit" | "selection" | "view" | "go" | "help";

/** Visible command state; execution belongs to the consumed dispatcher. */
export interface WorkbenchCommand {
  id: string;
  menu: WorkbenchMenu;
  label: string;
  paletteLabel?: string;
  enabled: boolean;
  reason?: string;
  shortcut?: string;
  checked?: boolean;
}
