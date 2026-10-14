import { useEffect, useRef } from "react";
import type { EditorContext } from "../../contracts/contracts";
import type { EditorAction } from "../../application/ports";
import type { FormatKind } from "../../domain/markdown-gui";
import { useI18n } from "../i18n/I18nProvider";

/** Screen position and focus restoration belonging to one editor gesture. */
export interface EditorMenuPoint {
  x: number;
  y: number;
  keyboard: boolean;
  /** Restore the exact editor view that opened the menu. */
  restoreFocus: () => void;
}

interface Props {
  point: EditorMenuPoint;
  context: EditorContext | null;
  popup: boolean;
  markdown: boolean;
  disabled: boolean;
  /** Run a revision-guarded native clipboard or history operation. */
  onAction: (action: EditorAction) => void;
  /** Format the captured authoritative native selection. */
  onFormat: (kind: FormatKind) => void;
  /** Close without changing the editor or its mappings. */
  onDismiss: (restoreFocus?: boolean) => void;
}

/** Editor-only native-action menu; opt-in selection formatting never takes focus. */
export function EditorMenu({ point, context, popup, markdown, disabled, onAction, onFormat, onDismiss }: Props) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const selected = context !== null && context.cursor.anchor !== context.cursor.head;
  const supported = context !== null && ["normal", "insert", "replace", "visual", "visual_line"].includes(context.mode);
  const writable = context?.presentation.editable ?? false;
  useEffect(() => {
    if (point.keyboard && !popup) host.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    /** Dismiss an editor menu when another surface receives a pointer gesture. */
    const outside = (event: PointerEvent) => { if (!host.current?.contains(event.target as Node)) onDismiss(false); };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [point, popup, onDismiss]);
  return <div ref={host} role={popup ? "toolbar" : "menu"} aria-label={t(popup ? "選択時の書式ポップアップ" : "エディターの操作")} data-editor-context-menu={!popup || undefined} className="fixed z-40 max-h-[70vh] min-w-44 max-w-80 overflow-auto rounded border border-border bg-card p-1 shadow-lg" style={{ left: Math.max(4, Math.min(point.x, window.innerWidth - 280)), top: Math.max(4, Math.min(point.y, window.innerHeight - 270)) }} onMouseDown={(event) => { if (popup) event.preventDefault(); }} onKeyDown={(event) => {
    if (popup) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onDismiss(); }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const buttons = [...(host.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[index]?.focus();
    }
  }}>
    {!popup && <>
      {([{ action: "undo", label: "元に戻す" }, { action: "redo", label: "やり直す" }, { action: "copy", label: "選択範囲をコピー" }, { action: "cut", label: "選択範囲を切り取る" }, { action: "paste", label: "クリップボードから貼り付け" }] as const).map(({ action, label }) => <button type="button" role="menuitem" className="block w-full rounded px-3 py-1.5 text-left text-xs hover:bg-muted focus:bg-muted disabled:opacity-40" key={action} disabled={disabled || !supported || (action !== "copy" && !writable) || ((action === "copy" || action === "cut") && !selected)} onClick={() => onAction(action)}>{t(label)}</button>)}
    </>}
    {markdown && selected && <div className="flex gap-1 border-t border-border p-1">
      {([{ kind: "bold", label: "太字" }, { kind: "italic", label: "斜体" }, { kind: "strike", label: "取消線" }, { kind: "code", label: "コード" }] as const).map(({ kind, label }) => <button type="button" role={popup ? undefined : "menuitem"} key={kind} disabled={disabled || !writable} className="rounded px-2 py-1 text-xs hover:bg-muted disabled:opacity-40" onClick={() => onFormat(kind)}>{t(label)}</button>)}
    </div>}
    {!popup && context && <details className="border-t border-border p-2 text-[11px] text-muted-foreground"><summary>{t("現在のVimマッピング")} ({context.mode})</summary><dl className="max-h-32 overflow-auto font-mono">{context.presentation.mappings.map((mapping) => <div key={mapping.lhs} className="mt-1 break-all"><dt className="inline">{mapping.lhs}</dt><dd className="inline"> → {mapping.rhs}</dd></div>)}</dl></details>}
  </div>;
}
