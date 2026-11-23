// Notion-style block editing for the CodeMirror editor (presentation).
//
// `/` at the start of a line opens a block menu while typing in Insert mode;
// in live preview, hovering a block shows a handle with `+` (add a block
// below) and a grip (drag to move, click for move / duplicate / delete).
// Every action is a CodeMirror transaction, so it reaches Neovim through the
// editor's normal revisioned GUI edit path.

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Extension, Text } from "@codemirror/state";
import type { TextEdit } from "../../contracts/contracts";
import type { Translator } from "../../contracts/localization";
import { computeLiveBlocks } from "../../domain/render/blocks";
import { BLOCK_TEMPLATES, databaseFlagEdit, deleteBlockEdit, duplicateBlockEdit, filterTemplates, moveBlockEdit, type BlockRange, type BlockTemplate } from "../../domain/block-edits";

/** Reads the current translator at event time. */
export type TranslatorSource = () => Translator;

interface MenuItem {
  label: string;
  icon: string;
  /** Perform the entry after the menu closes. */
  run: () => void;
}

/** Keyboard-driven popup list; owns its window listeners until closed. */
class FloatingMenu {
  readonly dom = document.createElement("div");
  private items: MenuItem[] = [];
  private index = 0;
  /** Window key listener bound to this menu. */
  private readonly onKey = (event: KeyboardEvent) => this.key(event);
  /** Close on a press outside the menu. */
  private readonly onPointer = (event: MouseEvent) => {
    if (!this.dom.contains(event.target as Node)) this.close();
  };

  /** Mount an empty menu and start capturing its keys before Vim sees them. */ constructor(anchor: HTMLElement, label: string, private readonly onClose: () => void) {
    this.dom.className = "marxen-block-menu";
    this.dom.setAttribute("role", "listbox");
    this.dom.setAttribute("aria-label", label);
    // Inside the themed root so the popup uses the same palette as the editor.
    (anchor.closest("[data-theme]") ?? document.body).append(this.dom);
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("mousedown", this.onPointer, true);
  }

  /** Replace the items and place the menu below `(x, y)`, kept inside the window. */ show(items: MenuItem[], x: number, y: number): void {
    this.items = items;
    this.index = Math.min(this.index, items.length - 1);
    this.render();
    const width = this.dom.offsetWidth || 260;
    const height = this.dom.offsetHeight || 300;
    this.dom.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`;
    this.dom.style.top = `${y + height + 4 > window.innerHeight ? Math.max(4, y - height - 24) : y + 4}px`;
  }

  /** Draw the options with the highlighted one marked for assistive tech. */ private render(): void {
    this.dom.replaceChildren(...this.items.map((item, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "marxen-block-menu-item";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === this.index));
      const icon = document.createElement("span");
      icon.className = "marxen-block-menu-icon";
      icon.textContent = item.icon;
      icon.setAttribute("aria-hidden", "true");
      option.append(icon, item.label);
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => this.choose(index));
      return option;
    }));
    this.dom.children[this.index]?.scrollIntoView?.({ block: "nearest" });
  }

  /** Navigate, choose or dismiss; other keys (typing the filter) pass through. */ private key(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1;
      this.index = (this.index + step + this.items.length) % this.items.length;
      this.render();
    } else if (event.key === "Enter" || event.key === "Tab") this.choose(this.index);
    else if (event.key === "Escape") this.close();
    else return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  /** Close first so the chosen action sees a settled editor. */ private choose(index: number): void {
    const item = this.items[index];
    this.close();
    item?.run();
  }

  /** Remove the popup and its listeners; idempotent. */ close(): void {
    if (!this.dom.isConnected) return;
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("mousedown", this.onPointer, true);
    this.dom.remove();
    this.onClose();
  }
}

/** Dispatch range edits as one user transaction and return focus to the editor. */
function dispatchEdits(view: EditorView, edits: TextEdit[], userEvent: string, caretAfter?: { edit: number; back: number }): void {
  const changes = view.state.changes(edits.map((edit) => ({ from: edit.range.start, to: edit.range.end, insert: edit.text })));
  const anchor = caretAfter ? changes.mapPos(edits[caretAfter.edit].range.end, 1) - caretAfter.back : undefined;
  view.dispatch({ changes, selection: anchor === undefined ? undefined : { anchor }, userEvent, scrollIntoView: true });
  view.focus();
}

/** Put a template's text over `[from, to)`, turning on database views when it needs them. */
function insertTemplate(view: EditorView, from: number, to: number, item: BlockTemplate, prefix = ""): void {
  const text = prefix + item.text;
  const edits: TextEdit[] = [{ range: { start: from, end: to }, text }];
  const flag = item.database ? databaseFlagEdit(view.state.doc.toString()) : null;
  if (flag) edits.unshift(flag);
  dispatchEdits(view, edits, "input.complete", { edit: edits.length - 1, back: text.length - prefix.length - item.caret });
}

/** Menu entries for templates, translated at open time. */
function templateItems(templates: readonly BlockTemplate[], t: Translator, run: (item: BlockTemplate) => void): MenuItem[] {
  return templates.map((item) => ({ label: t(item.label), icon: item.icon,
    /** Insert this template. */
    run: () => run(item) }));
}

const SLASH = /^(\s*)[/／]([^\s/／]*)$/;

/** `/` at a line start (after indentation) opens the block menu, filtered by what follows. */
export function slashMenu(translator: TranslatorSource): Extension {
  return ViewPlugin.fromClass(class {
    menu: FloatingMenu | null = null;
    from = 0;
    to = 0;

    /** Keep the view for later transactions. */ constructor(readonly view: EditorView) {}

    /** Open on a typed `/`, follow the filter text, close when the caret leaves it. */ update(update: ViewUpdate): void {
      if (!update.docChanged && !update.selectionSet) return;
      const selection = update.state.selection.main;
      const line = update.state.doc.lineAt(selection.head);
      const match = selection.empty ? SLASH.exec(update.state.doc.sliceString(line.from, selection.head)) : null;
      if (!match) return this.menu?.close();
      if (!this.menu) {
        // Only a freshly typed `/` opens the menu; snapshots and cursor moves never do.
        if (match[2] !== "" || !update.transactions.some((tr) => tr.isUserEvent("input.type"))) return;
        const t = translator();
        this.menu = new FloatingMenu(this.view.dom, t("ブロックを挿入"), () => { this.menu = null; });
      }
      this.from = line.from + match[1].length;
      this.to = selection.head;
      const t = translator();
      const items = templateItems(filterTemplates(match[2], (key) => t(key)), t, (item) => insertTemplate(this.view, this.from, this.to, item));
      if (items.length === 0) return this.menu.close();
      const menu = this.menu;
      const at = this.from;
      this.view.requestMeasure({
        /** Caret coordinates after layout. */
        read: (view) => view.coordsAtPos(at),
        /** Place the menu under the `/`. */
        write: (coords) => { if (coords) menu.show(items, coords.left, coords.bottom); },
      });
    }

    /** Close the menu with the editor. */ destroy(): void {
      this.menu?.close();
    }
  });
}

/** Top-level blocks a handle can act on (frontmatter stays a property panel). */
function handleBlocks(doc: Text): BlockRange[] {
  return computeLiveBlocks(doc.toString()).filter((block) => block.kind !== "frontmatter" && block.to > block.from);
}

/** Hover handle with `+` and a drag grip beside each block in live preview. */
export function blockHandles(translator: TranslatorSource): Extension {
  return ViewPlugin.fromClass(class {
    readonly handle = document.createElement("div");
    readonly indicator = document.createElement("div");
    menu: FloatingMenu | null = null;
    cache: { doc: Text; blocks: BlockRange[] } | null = null;
    index = -1;
    dragging = false;
    /** Track the block under the pointer. */
    private readonly onMove = (event: MouseEvent) => this.hover(event);
    /** Hide the handle while the page scrolls under it. */
    private readonly onScroll = () => { if (!this.dragging && !this.menu) this.hide(); };

    /** Build the handle and indicator once and listen for hover. */ constructor(readonly view: EditorView) {
      const t = translator();
      this.handle.className = "marxen-block-handle";
      this.handle.hidden = true;
      const add = this.button("+", t("下にブロックを追加"));
      add.addEventListener("click", () => this.openTemplates());
      const grip = this.button("⋮⋮", t("ドラッグで移動、クリックでメニュー"));
      grip.classList.add("marxen-block-grip");
      grip.addEventListener("pointerdown", (event) => this.startDrag(event, grip));
      this.handle.append(add, grip);
      for (const type of ["mousedown", "pointerdown"]) this.handle.addEventListener(type, (event) => event.stopPropagation());
      this.indicator.className = "marxen-block-drop";
      this.indicator.hidden = true;
      view.dom.append(this.handle, this.indicator);
      view.dom.addEventListener("mousemove", this.onMove);
      view.scrollDOM.addEventListener("scroll", this.onScroll);
    }

    /** One handle button that never takes focus from the editor. */ private button(text: string, label: string): HTMLButtonElement {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text;
      button.title = label;
      button.setAttribute("aria-label", label);
      button.addEventListener("mousedown", (event) => event.preventDefault());
      return button;
    }

    /** Blocks of the current document, parsed once per document version. */ private blocks(): BlockRange[] {
      if (this.cache?.doc !== this.view.state.doc) this.cache = { doc: this.view.state.doc, blocks: handleBlocks(this.view.state.doc) };
      return this.cache.blocks;
    }

    /** Top and bottom of a block in client coordinates. */ private bounds(block: BlockRange): { top: number; bottom: number } {
      const top = this.view.documentTop;
      return { top: top + this.view.lineBlockAt(block.from).top, bottom: top + this.view.lineBlockAt(block.to).bottom };
    }

    /** Show the handle beside the block under the pointer. */ private hover(event: MouseEvent): void {
      if (this.dragging || this.menu || !this.view.state.facet(EditorView.editable)) return;
      if (this.handle.contains(event.target as Node)) return;
      const content = this.view.contentDOM.getBoundingClientRect();
      const at = this.view.posAtCoords({ x: content.left + 2, y: event.clientY }, false);
      const blocks = this.blocks();
      const index = blocks.findIndex((block) => at >= block.from && at <= block.to);
      if (index < 0) return this.hide();
      this.index = index;
      const gutters = this.view.dom.querySelector(".cm-gutters")?.getBoundingClientRect();
      const edge = gutters && gutters.width > 0 ? gutters.left : content.left;
      const frame = this.view.dom.getBoundingClientRect();
      this.handle.hidden = false;
      this.handle.style.top = `${this.bounds(blocks[index]).top - frame.top}px`;
      this.handle.style.left = `${Math.max(0, edge - frame.left - this.handle.offsetWidth - 4)}px`;
    }

    /** Hide the handle. */ private hide(): void {
      this.handle.hidden = true;
      this.index = -1;
    }

    /** Open a floating menu beside the handle. */ private openMenu(label: string, items: MenuItem[]): void {
      this.menu?.close();
      this.menu = new FloatingMenu(this.view.dom, label, () => { this.menu = null; });
      const rect = this.handle.getBoundingClientRect();
      this.menu.show(items, rect.right, rect.top + rect.height);
    }

    /** `+`: choose a block to insert below the hovered one. */ private openTemplates(): void {
      const block = this.blocks()[this.index];
      if (!block) return;
      const t = translator();
      this.openMenu(t("ブロックを挿入"), templateItems(BLOCK_TEMPLATES, t, (item) => insertTemplate(this.view, block.to, block.to, item, "\n\n")));
    }

    /** Grip click: move, duplicate or delete the hovered block. */ private openActions(index: number): void {
      const blocks = this.blocks();
      const text = this.view.state.doc.toString();
      const t = translator();
      /** Menu entry dispatching one edit when it exists. */
      const action = (label: string, icon: string, edit: () => TextEdit | null, userEvent: string): MenuItem => ({ label, icon,
        /** Apply the action edit when there is one. */
        run: () => {
        const change = edit();
        if (change) dispatchEdits(this.view, [change], userEvent);
      } });
      this.openMenu(t("ブロックの操作"), [
        action(t("上へ移動"), "↑", () => moveBlockEdit(text, blocks, index, index - 1), "move"),
        action(t("下へ移動"), "↓", () => moveBlockEdit(text, blocks, index, index + 2), "move"),
        action(t("複製"), "⧉", () => duplicateBlockEdit(text, blocks[index]), "input.paste"),
        action(t("削除"), "🗑", () => deleteBlockEdit(blocks, index), "delete"),
      ]);
    }

    /** Insertion slot (`0..blocks.length`) nearest to a client y. */ private slot(y: number): number {
      const blocks = this.blocks();
      const found = blocks.findIndex((block) => {
        const { top, bottom } = this.bounds(block);
        return y < (top + bottom) / 2;
      });
      return found < 0 ? blocks.length : found;
    }

    /** Drag the grip to a slot; a press without movement opens the action menu. */ private startDrag(event: PointerEvent, grip: HTMLElement): void {
      if (event.button !== 0 || this.index < 0) return;
      event.preventDefault();
      const index = this.index;
      const startY = event.clientY;
      let before = -1;
      grip.setPointerCapture?.(event.pointerId);
      /** Follow the pointer with the drop line once it moved a few pixels. */
      const move = (moveEvent: PointerEvent) => {
        if (!this.dragging && Math.abs(moveEvent.clientY - startY) < 4) return;
        this.dragging = true;
        before = this.slot(moveEvent.clientY);
        const blocks = this.blocks();
        const frame = this.view.dom.getBoundingClientRect();
        const content = this.view.contentDOM.getBoundingClientRect();
        const y = before < blocks.length ? this.bounds(blocks[before]).top - 2 : this.bounds(blocks[blocks.length - 1]).bottom + 2;
        this.indicator.hidden = false;
        this.indicator.style.top = `${y - frame.top}px`;
        this.indicator.style.left = `${content.left - frame.left}px`;
        this.indicator.style.width = `${content.width}px`;
      };
      /** Drop the block, or open the menu when it was a click. */
      const end = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", end);
        grip.removeEventListener("pointercancel", end);
        this.indicator.hidden = true;
        if (!this.dragging) return this.openActions(index);
        this.dragging = false;
        this.hide();
        const edit = before < 0 ? null : moveBlockEdit(this.view.state.doc.toString(), this.blocks(), index, before);
        if (edit) dispatchEdits(this.view, [edit], "move");
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", end);
      grip.addEventListener("pointercancel", end);
    }

    /** Hide stale handles after edits move blocks. */ update(update: ViewUpdate): void {
      if (update.docChanged && !this.dragging) this.hide();
    }

    /** Remove the handle, indicator and listeners with the plugin. */ destroy(): void {
      this.menu?.close();
      this.view.dom.removeEventListener("mousemove", this.onMove);
      this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
      this.handle.remove();
      this.indicator.remove();
    }
  });
}
