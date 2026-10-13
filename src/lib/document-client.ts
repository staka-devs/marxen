// Document client: revision-tracked range edits against the Rust actor.
//
// Desktop (Tauri) owns the buffer: every GUI change goes through
// `apply_gui_edits` with an exact `baseRevision`; stale revisions resync
// from `fetch_snapshot`. Issue #4 owns all Rust IPC; this file adds no new
// commands and implements no divergent Rust state.
//
// When IPC is absent (browser demo) the document is read-only: mutations
// are rejected with a Japanese message and save success is never simulated.

import { invoke, isTauri } from "@tauri-apps/api/core";
import type { CursorUpdate, DocumentSnapshot, TextEdit, VimMode } from "../shared/contracts";

export const READONLY_MESSAGE = "ブラウザ表示では編集できません。デスクトップで開いてください。";

export interface DocumentTransport {
  openDocument(documentId: string, text: string, path?: string): Promise<DocumentSnapshot>;
  fetchSnapshot(): Promise<DocumentSnapshot>;
  applyGuiEdits(documentId: string, baseRevision: number, edits: TextEdit[]): Promise<DocumentSnapshot>;
  saveDocument(documentId: string, baseRevision: number): Promise<{ revision: number; dirty: boolean }>;
  fetchMode(): Promise<{ mode: VimMode; revision: number }>;
  undoDocument(): Promise<DocumentSnapshot>;
  reportCursor(update: CursorUpdate): Promise<CursorUpdate>;
}

class TauriTransport implements DocumentTransport {
  openDocument(documentId: string, text: string, path?: string): Promise<DocumentSnapshot> {
    return invoke<DocumentSnapshot>("open_document", { documentId, text, path: path ?? null });
  }
  fetchSnapshot(): Promise<DocumentSnapshot> {
    return invoke<DocumentSnapshot>("fetch_snapshot");
  }
  applyGuiEdits(documentId: string, baseRevision: number, edits: TextEdit[]): Promise<DocumentSnapshot> {
    return invoke<DocumentSnapshot>("apply_gui_edits", { documentId, baseRevision, edits });
  }
  saveDocument(documentId: string, baseRevision: number): Promise<{ revision: number; dirty: boolean }> {
    return invoke("save_document", { documentId, baseRevision });
  }
  async fetchMode(): Promise<{ mode: VimMode; revision: number }> {
    const update = await invoke<{ documentId: string; revision: number; mode: VimMode }>("fetch_mode");
    return { mode: update.mode, revision: update.revision };
  }
  undoDocument(): Promise<DocumentSnapshot> {
    return invoke<DocumentSnapshot>("undo_document");
  }
  reportCursor(update: CursorUpdate): Promise<CursorUpdate> {
    return invoke<CursorUpdate>("report_cursor", {
      documentId: update.documentId,
      revision: update.revision,
      anchor: update.anchor,
      head: update.head,
    });
  }
}

/** Browser demo: read-only. Never claims a save or a revision bump. */
export class ReadonlyTransport implements DocumentTransport {
  async openDocument(_documentId?: string, _text?: string, _path?: string): Promise<DocumentSnapshot> {
    throw new Error(READONLY_MESSAGE);
  }
  async fetchSnapshot(): Promise<DocumentSnapshot> {
    throw new Error(READONLY_MESSAGE);
  }
  async applyGuiEdits(_documentId?: string, _baseRevision?: number, _edits?: TextEdit[]): Promise<DocumentSnapshot> {
    throw new Error(READONLY_MESSAGE);
  }
  async saveDocument(_documentId?: string, _baseRevision?: number): Promise<{ revision: number; dirty: boolean }> {
    throw new Error(READONLY_MESSAGE);
  }
  async fetchMode(): Promise<{ mode: VimMode; revision: number }> {
    throw new Error(READONLY_MESSAGE);
  }
  async undoDocument(): Promise<DocumentSnapshot> {
    throw new Error(READONLY_MESSAGE);
  }
  async reportCursor(): Promise<CursorUpdate> {
    throw new Error(READONLY_MESSAGE);
  }
}

export function createTransport(): DocumentTransport {
  try {
    if (isTauri()) return new TauriTransport();
  } catch {
    // jsdom / Vitest has no Tauri globals: fall through to read-only.
  }
  return new ReadonlyTransport();
}

export function isDesktop(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

/**
 * Composition gate: while `composing` (IME preedit), buffer CodeMirror
 * transactions and commit exactly once on `compositionend`. The Rust
 * contract accepts only committed text; preedit never reaches Neovim.
 * Normal-mode IME keys are not intercepted as motions: the gate only
 * suppresses document changes, never key handling.
 */
export class CompositionGate {
  private composing = false;
  private pending: TextEdit[] = [];

  get isComposing(): boolean {
    return this.composing;
  }

  start(): void {
    this.composing = true;
    this.pending = [];
  }

  /** Buffer while composing; pass through when not composing. */
  offer(edits: TextEdit[]): TextEdit[] | null {
    if (!this.composing) return edits;
    this.pending = edits;
    return null;
  }

  /** Commit once: returns the final edits and clears the gate. */
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

  cancel(): void {
    this.composing = false;
    this.pending = [];
  }
}
