import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import type { WorkbenchCommand } from "../../contracts/workbench";
import type { ThemeId } from "../../domain/workspace-content";

interface Props {
  label: string;
  point: { x: number; y: number };
  theme?: ThemeId;
  commands: WorkbenchCommand[];
  /** Execute a command after closing the popup and restoring its origin. */
  onRun: (id: string) => void;
  /** Dismiss and optionally restore the origin's focus. */
  onDismiss: (restore?: boolean) => void;
  /** Move between adjacent top-level menus when this popup belongs to a menubar. */
  onHorizontal?: (direction: number) => void;
}

/** Quiet anchored dropdown shared by the menubar and explorer context menu. */
export function CommandMenu({ label, point, commands, onRun, onDismiss, onHorizontal, theme }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const dismiss = useRef(onDismiss); dismiss.current = onDismiss;
  const [position, setPosition] = useState(point);
  useLayoutEffect(() => {
    /** Keep an already-open dropdown inside the viewport when its window is resized. */
    const place = () => {
      const bounds = panel.current?.getBoundingClientRect();
      setPosition({ x: Math.max(4, Math.min(point.x, window.innerWidth - (bounds?.width ?? 260) - 4)), y: Math.max(4, Math.min(point.y, window.innerHeight - (bounds?.height ?? 260) - 4)) });
    };
    place(); window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [point.x, point.y]);
  useEffect(() => {
    (panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? panel.current)?.focus();
    /** Dismiss a popup for gestures outside it and outside its menubar triggers. */
    const outside = (event: PointerEvent) => { if (event.target instanceof Element && !panel.current?.contains(event.target) && !event.target.closest("[data-workbench-menu-trigger]")) dismiss.current(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  return createPortal(<div ref={panel} data-theme={theme} role="menu" tabIndex={-1} aria-label={label} className="fixed z-40 max-h-[calc(100dvh-8px)] w-64 max-w-[calc(100vw-8px)] overflow-y-auto rounded-sm border border-border bg-card p-1 text-foreground shadow-lg" style={{ left: position.x, top: position.y }} onKeyDown={(event) => {
    if (event.isPropagationStopped()) return;
    if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") event.preventDefault(); event.stopPropagation(); onDismiss(event.key === "Escape"); }
    else if (onHorizontal && ["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); onHorizontal(event.key === "ArrowRight" ? 1 : -1); }
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const items = [...(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  }}>{commands.map((item) => <button key={item.id} type="button" role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"} aria-checked={item.checked} disabled={!item.enabled} aria-disabled={!item.enabled} title={item.reason} data-command={item.id} onClick={() => { if (!item.enabled) return; onDismiss(); onRun(item.id); }} className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-xs hover:bg-muted focus:bg-muted focus:outline-none disabled:opacity-40">
    <span className="w-3 shrink-0">{item.checked && <Check size={12} aria-hidden />}</span><span className="min-w-0 flex-1">{item.label}</span>{item.shortcut && <kbd className="shrink-0 text-[10px] text-muted-foreground">{item.shortcut}</kbd>}
  </button>)}</div>, document.body);
}
