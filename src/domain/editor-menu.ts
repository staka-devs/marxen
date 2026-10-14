import type { VimMode } from "../contracts/contracts";

/** Contiguous native selection operations exclude rectangular and command/terminal modes. */
export function supportsEditorSelection(mode: VimMode): boolean {
  return ["normal", "insert", "replace", "visual", "visual_line"].includes(mode);
}
