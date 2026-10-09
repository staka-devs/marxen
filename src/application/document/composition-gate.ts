// IME composition gate (application).
//
// Buffers editor transactions while composing (IME preedit) and commits
// exactly once on `compositionend`. The registry accepts only committed text;
// preedit never reaches Neovim. Pure state machine with no Tauri, DOM, React,
// or browser globals.

import type { TextEdit } from "../../contracts/contracts";

/**
 * Gate that suppresses document changes during IME composition.
 *
 * Normal-mode IME keys are not intercepted as motions: the gate only
 * suppresses document changes, never key handling. Real TSF (Windows
 * WebView2), NSTextInput (macOS), and IBus/Fcitx (Linux) behavior stays
 * unverified here by design; unit tests cover DOM plumbing only.
 */
export class CompositionGate {
  private composing = false;
  private pending: TextEdit[] = [];

  /** Whether an IME preedit session is currently open. */
  get isComposing(): boolean {
    return this.composing;
  }

  /** Open a composition session, clearing any previously buffered edits. */
  start(): void {
    this.composing = true;
    this.pending = [];
  }

  /**
   * Offer edits to the gate, buffering while composing.
   *
   * Returns the edits for immediate send when not composing, or null while
   * composing (the edits are buffered for the later commit).
   */
  offer(edits: TextEdit[]): TextEdit[] | null {
    if (!this.composing) return edits;
    this.pending = edits;
    return null;
  }

  /**
   * Commit once and clear the gate, returning the final edits.
   *
   * Explicit `finalEdits` win when non-empty; otherwise the buffered pending
   * edits are returned, or null when nothing was buffered.
   */
  commit(finalEdits?: TextEdit[]): TextEdit[] | null {
    this.composing = false;
    if (finalEdits && finalEdits.length > 0) {
      this.pending = [];
      return finalEdits;
    }
    const out = this.pending;
    this.pending = [];
    return out.length > 0 ? out : null;
  }

  /** Cancel the session, discarding buffered preedit without committing. */
  cancel(): void {
    this.composing = false;
    this.pending = [];
  }
}
