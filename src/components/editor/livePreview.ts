// Inline live preview for the CodeMirror editor (Issue #6, ADR-0061).
//
// A CodeMirror StateField maps shared-AST block ranges to replacement
// decorations: inactive blocks render as widgets INSIDE `.cm-content` while
// the block holding the selection (or cursor) stays raw source. Positions
// are UTF-16 offsets into the original Markdown, so the cursor and every
// edit stay tied to the real document: widgets never reserialize anything.
//
// Interactions emit the existing range-edit callbacks (native Neovim
// revisions on the backend): task checkboxes toggle in place, table-cell
// clicks select the exact source span for raw editing, and clicks on other
// rich content move the cursor into the matching source span. Special views
// (Mermaid / maps / 3D) hydrate inside widgets with the same abort/dispose
// lifecycles as the read preview; destroying a widget aborts its pass and
// disposes its maps and GL resources.

import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { RangeSetBuilder, StateField, type Extension } from "@codemirror/state";
import { computeLiveBlocks, extractLinkDefinitions, findTableCellRange, type LiveBlock } from "../../lib/render/blocks";
import { renderMarkdownDocument } from "../../lib/render/pipeline";
import { toggleCheckbox } from "../../lib/markdown-gui";
import { disposeMarkdownView, hydrateMarkdownView } from "../preview/hydrate";
import type { TextEdit } from "../../shared/contracts";

export interface LivePreviewCallbacks {
  onGuiEdits?: (edits: TextEdit[]) => void;
  /** Move the editor cursor into a source span (activates its block). */
  focusSource?: (from: number, to: number) => void;
}

/** Rendered HTML by block key (`kind + text + definitions`). */
const htmlCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
const MAX_CACHE_ENTRIES = 300;

function cacheKey(kind: string, blockText: string, defs: string): string {
  return `${kind}\n${blockText}<DEFS>${defs}`;
}

function rememberHtml(key: string, html: string): void {
  htmlCache.set(key, html);
  if (htmlCache.size > MAX_CACHE_ENTRIES) {
    const oldest = htmlCache.keys().next();
    if (!oldest.done) htmlCache.delete(oldest.value);
  }
}

function renderBlockHtml(key: string, blockText: string, defs: string): Promise<string> {
  const hit = htmlCache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const running = inflight.get(key);
  if (running) return running;
  const task = renderMarkdownDocument(blockText + (defs === "" ? "" : `\n\n${defs}`))
    .then((result) => {
      rememberHtml(key, result.html);
      return result.html;
    })
    .catch(() => {
      const fallback = `<div class="marxen-error" role="alert">描画できませんでした。原文は保持されています。</div>`;
      rememberHtml(key, fallback);
      return fallback;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, task);
  return task;
}

/** Nearest occurrence of a vanished block's text (cell commits relocate). */
function relocateBlock(docText: string, blockText: string, hint: number): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let at = docText.indexOf(blockText);
  while (at >= 0) {
    const distance = Math.abs(at - hint);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = at;
    }
    at = docText.indexOf(blockText, at + 1);
  }
  return best;
}

function findFootnoteDefinition(docText: string, label: string): number {
  // NOTE: horizontal whitespace only -- `\s` would swallow the preceding
  // newline and report the previous blank line instead of the definition.
  const match = new RegExp(`^[ \t]{0,3}\\[\\^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]:`, "m").exec(docText);
  return match?.index ?? -1;
}

interface HostBinding {
  from: number;
  text: string;
  defs: string;
  getCallbacks: () => LivePreviewCallbacks;
}

function readBinding(host: HTMLElement): HostBinding | null {
  return (host as unknown as { __liveBinding?: HostBinding }).__liveBinding ?? null;
}

function writeBinding(host: HTMLElement, binding: HostBinding): void {
  (host as unknown as { __liveBinding?: HostBinding }).__liveBinding = binding;
}

function abortHost(host: HTMLElement): void {
  const controller = (host as unknown as { __liveController?: AbortController }).__liveController;
  (host as unknown as { __liveController?: AbortController }).__liveController = undefined;
  try {
    controller?.abort();
  } catch {
    // Already settled: teardown stays idempotent.
  }
}

class LiveBlockWidget extends WidgetType {
  constructor(
    readonly key: string,
    readonly kind: string,
    readonly blockFrom: number,
    readonly blockText: string,
    readonly defs: string,
    readonly getCallbacks: () => LivePreviewCallbacks,
  ) {
    super();
  }

  eq(other: LiveBlockWidget): boolean {
    // Identity pins exact text AND position: inserting text before an
    // identical retained block must not reuse stale offsets or handlers.
    return other instanceof LiveBlockWidget && other.key === this.key && other.blockFrom === this.blockFrom;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    // Same widget type, shifted or recontextualized content: refresh the
    // binding in place instead of redrawing. Delegated listeners read the
    // binding at event time, so no stale closure can survive.
    if (!(dom instanceof HTMLElement) || !dom.classList.contains("marxen-live-widget")) return false;
    dom.dataset.liveKey = this.key;
    dom.dataset.liveFrom = String(this.blockFrom);
    dom.dataset.liveTo = String(this.blockFrom + this.blockText.length);
    writeBinding(dom, { from: this.blockFrom, text: this.blockText, defs: this.defs, getCallbacks: this.getCallbacks });
    if (dom.dataset.liveFilled !== this.key) {
      abortHost(dom);
      disposeMarkdownView(dom);
      dom.innerHTML = `<div class="marxen-live-loading" aria-hidden="true">描画しています…</div>`;
      void this.fillAsync(dom, view);
    }
    return true;
  }

  ignoreEvent(event: Event): boolean {
    const target = event.target as HTMLElement | null;
    const host = target?.closest?.(".marxen-live-widget");
    if (!host) return false;
    // Interactive content handles itself, but only when it lives inside this
    // widget: an unscoped closest() would climb past the widget and match the
    // editor root itself (contenteditable), swallowing every gesture.
    const interactive = target?.closest?.("input,td,th,a,button,summary");
    return !!interactive && host.contains(interactive);
  }

  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement("div");
    host.className = "marxen-live-widget";
    host.dataset.liveKey = this.key;
    // Source range for the extension-level mousedown activation below.
    host.dataset.liveFrom = String(this.blockFrom);
    host.dataset.liveTo = String(this.blockFrom + this.blockText.length);
    writeBinding(host, { from: this.blockFrom, text: this.blockText, defs: this.defs, getCallbacks: this.getCallbacks });
    // Delegated once per host: later updateDOM refreshes only rebind the
    // data above, so handlers can never close over stale offsets.
    host.addEventListener("change", (event) => this.onHostChange(host, view, event));
    host.addEventListener("click", (event) => this.onHostClick(host, view, event));
    host.addEventListener("keydown", (event) => this.onHostKey(host, event));
    const cached = htmlCache.get(this.key);
    if (cached !== undefined) {
      this.fill(host, cached);
    } else {
      host.innerHTML = `<div class="marxen-live-loading" aria-hidden="true">描画しています…</div>`;
      void this.fillAsync(host, view);
    }
    return host;
  }

  destroy(dom: HTMLElement): void {
    abortHost(dom);
    disposeMarkdownView(dom);
  }

  private async fillAsync(host: HTMLElement, view: EditorView): Promise<void> {
    const html = await renderBlockHtml(this.key, this.blockText, this.defs);
    // Stale guard: the widget may have been replaced or the view destroyed
    // while rendering. The key pins exact block text, so a connected node
    // with this key is always current.
    if (!host.isConnected) return;
    if (!view.contentDOM.contains(host)) return;
    if (host.dataset.liveKey !== this.key) return;
    this.fill(host, html);
  }

  private fill(host: HTMLElement, html: string): void {
    // Idempotent per key: rebuilds may hand a fresh widget instance the same
    // reused DOM (eq match), and every pending fill races to populate it.
    // The first fill wins; the rest (same key, same content) stand down.
    if (host.dataset.liveFilled === this.key) return;
    if (host.dataset.liveKey !== this.key) return;
    host.dataset.liveFilled = this.key;
    host.innerHTML = `<div class="marxen-md marxen-live-body">${html}</div>`;
    const body = host.firstElementChild as HTMLElement | null;
    if (!body) return;
    // Pipeline HTML disables task boxes; live widgets own them instead.
    body.querySelectorAll('li.task-list-item > input[type="checkbox"]').forEach((box) => box.removeAttribute("disabled"));
    // Cells stay keyboard-reachable for jump activation.
    body.querySelectorAll("td,th").forEach((cell) => {
      if (!cell.hasAttribute("tabindex")) cell.setAttribute("tabindex", "0");
    });
    abortHost(host);
    const controller = new AbortController();
    (host as unknown as { __liveController?: AbortController }).__liveController = controller;
    void hydrateMarkdownView(body, controller.signal);
  }

  private taskOffsets(binding: HostBinding): number[] {
    // Source offsets of each `- [ ]` / `- [x]` marker, in document order to
    // match the rendered checkboxes.
    const offsets: number[] = [];
    const pattern = /^(\s*(?:[-*]|\d+[.)])\s+)\[([ xX])\]/gm;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(binding.text)) !== null) {
      offsets.push(binding.from + match.index + match[1].length + 1);
    }
    return offsets;
  }

  private onHostChange(host: HTMLElement, view: EditorView, event: Event): void {
    const target = event.target as HTMLElement | null;
    const box = target?.closest?.('li.task-list-item > input[type="checkbox"]') as HTMLInputElement | null;
    if (!box || !host.contains(box)) return;
    const binding = readBinding(host);
    if (!binding) return;
    const boxes = [...host.querySelectorAll('li.task-list-item > input[type="checkbox"]')];
    const index = boxes.indexOf(box);
    if (index < 0) return;
    // Revert the optimistic flip: the authoritative state arrives with
    // the Neovim snapshot, and a rejected edit must never stick.
    box.checked = !box.checked;
    const docText = view.state.doc.toString();
    const at = relocateBlock(docText, binding.text, binding.from);
    if (at < 0) return;
    const marker = this.taskOffsets(binding)[index];
    if (marker === undefined) return;
    // Relocated markers shift with the block; the marker index stays.
    const shifted = at - binding.from + marker;
    try {
      binding.getCallbacks().onGuiEdits?.(toggleCheckbox(docText, shifted));
    } catch {
      // Invalid marker positions never reach the backend.
    }
  }

  private onHostClick(host: HTMLElement, view: EditorView, event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    const binding = readBinding(host);
    if (!binding) return;
    const cell = target?.closest?.("td,th") as HTMLTableCellElement | null;
    if (cell && host.contains(cell)) {
      event.stopPropagation();
      // View-only cells: select the exact source span (escaped pipes and
      // code spans intact) so typing replaces just the cell through the
      // normal range callbacks.
      const table = cell.closest("table");
      const tr = cell.parentElement as HTMLTableRowElement | null;
      if (!table || !tr) return;
      const rows = [...table.rows];
      const rowIndex = rows.indexOf(tr);
      const colIndex = [...tr.cells].indexOf(cell);
      if (rowIndex < 0 || colIndex < 0) return;
      const docText = view.state.doc.toString();
      const at = relocateBlock(docText, binding.text, binding.from);
      if (at < 0) return;
      const span = findTableCellRange(docText.slice(at, at + binding.text.length), at, rowIndex, colIndex);
      if (!span) return;
      binding.getCallbacks().focusSource?.(span.from, span.to);
      return;
    }
    const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (anchor && host.contains(anchor)) {
      event.preventDefault();
      event.stopPropagation();
      const href = anchor.getAttribute("href") ?? "";
      const docText = view.state.doc.toString();
      if (href.startsWith("#")) {
        // Footnote refs jump to their definition; other anchors reveal the block.
        const footnote = /fn(?:ref)?-(.+)$/.exec(href.slice(1));
        if (footnote) {
          const at = findFootnoteDefinition(docText, footnote[1]);
          if (at >= 0) {
            binding.getCallbacks().focusSource?.(at, at);
            return;
          }
        }
      }
      // Links never navigate inside the editor: reveal the source instead.
      binding.getCallbacks().focusSource?.(binding.from, binding.from);
    }
  }

  private onHostKey(host: HTMLElement, event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const cell = target?.closest?.("td,th");
    if (!cell || !host.contains(cell)) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      cell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    } else {
      event.stopPropagation();
    }
  }
}

function buildDecorations(docText: string, selFrom: number, selTo: number, defs: string, getCallbacks: () => LivePreviewCallbacks): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const block of computeLiveBlocks(docText)) {
    if (block.to <= block.from) continue;
    // The block holding the selection (or cursor) stays raw source so every
    // keystroke lands on the original Markdown through normal callbacks.
    if (selFrom <= block.to && selTo >= block.from) continue;
    const text = docText.slice(block.from, block.to);
    builder.add(
      block.from,
      block.to,
      Decoration.replace({
        widget: new LiveBlockWidget(cacheKey(block.kind, text, defs), block.kind, block.from, text, defs, getCallbacks),
        block: true,
      }),
    );
  }
  return builder.finish();
}

export function createLivePreview(getCallbacks: () => LivePreviewCallbacks): Extension {
  const field = StateField.define<DecorationSet>({
    create(state) {
      const sel = state.selection.main;
      return buildDecorations(state.doc.toString(), sel.from, sel.to, extractLinkDefinitions(state.doc.toString()), getCallbacks);
    },
    update(decos, tr) {
      const sel = tr.state.selection.main;
      const before = tr.startState.selection.main;
      if (!tr.docChanged && sel.eq(before)) return decos;
      return buildDecorations(
        tr.state.doc.toString(),
        sel.from,
        sel.to,
        extractLinkDefinitions(tr.state.doc.toString()),
        getCallbacks,
      );
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  // Widget-chrome activation at CodeMirror's own event gate. A plain click
  // on rendered content moves the cursor into that block (revealing raw
  // source): handling it here runs before any rebuild, so coordinates are
  // still valid -- a later click-phase correction would map onto the
  // neighbouring newline left behind by the layout shift. Returning true
  // suppresses CodeMirror's default placement for exactly this gesture.
  const activation = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey) return false;
      const target = event.target as HTMLElement | null;
      const host = target?.closest?.(".marxen-live-widget") as HTMLElement | null;
      if (!host) return false;
      // Interactive descendants manage themselves (checkboxes, cells, links):
      // scoped to this widget so the editor root (contenteditable) never
      // matches and swallows widget-chrome gestures.
      const interactive = target?.closest?.("input,td,th,a,button,summary");
      if (interactive && host.contains(interactive)) return false;
      const from = Number(host.dataset.liveFrom ?? "-1");
      const to = Number(host.dataset.liveTo ?? "-1");
      if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) return false;
      event.preventDefault();
      let at: number | null = null;
      try {
        at = view.posAtCoords({ x: event.clientX, y: event.clientY });
      } catch {
        at = null;
      }
      if (at === null || at < from || at > to) at = from;
      getCallbacks().focusSource?.(at, at);
      return true;
    },
  });
  return [field, activation];
}

export type { LiveBlock };
