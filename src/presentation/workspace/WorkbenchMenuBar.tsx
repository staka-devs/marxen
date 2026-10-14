import { useRef, useState } from "react";
import type { WorkbenchCommand, WorkbenchMenu } from "../../contracts/workbench";
import { useI18n } from "../i18n/I18nProvider";
import { CommandMenu } from "./CommandMenu";
import type { ThemeId } from "../../domain/workspace-content";

interface Props {
  theme?: ThemeId;
  commands: WorkbenchCommand[];
  /** Execute through the same dispatcher used by the palette and shortcuts. */
  onRun: (id: string) => void;
  /** Capture authoritative editor context before the menubar moves focus. */
  onPrepare: (origin: HTMLElement | null) => void;
}
const MENUS = [["file", "ファイル"], ["edit", "編集"], ["selection", "選択"], ["view", "表示"], ["go", "移動"], ["help", "ヘルプ"]] as const;

/** Compact horizontal workbench menus with roving focus and bounded popup placement. */
export function WorkbenchMenuBar({ commands, onRun, onPrepare, theme }: Props) {
  const { t } = useI18n();
  const host = useRef<HTMLElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState<{ id: WorkbenchMenu; point: { x: number; y: number } } | null>(null);
  /** Open a menu from its actual trigger bounds and capture the originating editor once. */
  function show(next: number) {
    const button = host.current?.querySelectorAll<HTMLButtonElement>("button")[next];
    if (!button) return;
    if (!open) onPrepare(origin.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
    const bounds = button.getBoundingClientRect();
    setIndex(next); setOpen({ id: MENUS[next][0], point: { x: bounds.left, y: bounds.bottom } });
  }
  /** Close the popup and return focus only for explicit dismissal or execution. */
  function dismiss(restore = true) {
    setOpen(null);
    if (restore) host.current?.querySelectorAll<HTMLButtonElement>("button")[index]?.focus();
  }
  return <header ref={host} role="menubar" aria-label={t("メインメニュー")} className="flex h-8 min-h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border bg-card px-1 text-[12px]" onKeyDown={(event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? 5 : (index + (event.key === "ArrowRight" ? 1 : -1) + 6) % 6;
      setIndex(next); host.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
      if (open) show(next);
    } else if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); show(index); }
  }}>{MENUS.map(([id, label], position) => <button key={id} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={open?.id === id} tabIndex={index === position ? 0 : -1} data-workbench-menu-trigger onFocus={() => setIndex(position)} onPointerDown={() => { if (!open) origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }} onFocusCapture={(event) => { if (!open && event.relatedTarget instanceof HTMLElement && !host.current?.contains(event.relatedTarget)) origin.current = event.relatedTarget; }} onClick={() => { if (open?.id === id) dismiss(); else show(position); }} className={`h-7 shrink-0 rounded-sm px-2 hover:bg-muted focus:bg-muted focus:outline-none ${open?.id === id ? "bg-muted" : ""}`}>{t(label)}</button>)}
    {open && <CommandMenu theme={theme} key={open.id} label={t(MENUS.find(([id]) => id === open.id)![1])} point={open.point} commands={commands.filter((item) => item.menu === open.id)} onRun={onRun} onDismiss={dismiss} onHorizontal={(direction) => show((index + direction + 6) % 6)} />}
  </header>;
}
