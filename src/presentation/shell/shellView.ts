// Shell view-state value types shared by the layout and its hooks.

/** Editor/preview arrangement for the main pane. */
export type ViewMode = "live" | "source" | "read" | "split";
/** Cursor motion basis: wrapped display lines or native Vim movement. */
export type NavBasis = "display" | "source";
/** Sidebar panel selection, or null when the sidebar is hidden. */
export type SideView = "explorer" | "search" | "outline";
