import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

/** A real selectable value and its user-facing purpose. */
export interface Choice {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

interface Props {
  label: string;
  value: string;
  choices: readonly Choice[];
  disabled?: boolean;
  /** Commit the chosen value without interpreting provider identifiers. */
  onChange: (value: string) => void;
}

/** Compact, themed selection with a readable popup and keyboard navigation. */
export function ChoiceMenu({ label, value, choices, disabled, onChange }: Props) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [position, setPosition] = useState({ left: 8, top: 8, width: 320, height: 320, above: false });
  const selected = choices.find((choice) => choice.value === value);
  /** Open at the selected choice while leaving focus on the combobox. */
  function openMenu() {
    const index = choices.findIndex((choice) => choice.value === value && !choice.disabled);
    setHighlight(index >= 0 ? index : Math.max(0, choices.findIndex((choice) => !choice.disabled)));
    setOpen(true); trigger.current?.focus();
  }
  /** Commit only enabled advertised choices and close the popup. */
  function choose(index: number) {
    const choice = choices[index];
    if (!choice || choice.disabled) return;
    onChange(choice.value); setOpen(false); trigger.current?.focus();
  }
  useLayoutEffect(() => {
    if (!open) return;
    /** Keep the popup within the viewport above or below its trigger. */
    const reposition = () => {
      const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
      const width = Math.min(340, window.innerWidth - 16);
      const above = rect.top > window.innerHeight - rect.bottom && rect.top > 160;
      const height = Math.min(320, Math.max(80, above ? rect.top - 16 : window.innerHeight - rect.bottom - 16));
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: above ? window.innerHeight - rect.top + 4 : rect.bottom + 4, width, height, above });
    };
    reposition(); window.addEventListener("resize", reposition); window.addEventListener("scroll", reposition, true);
    return () => { window.removeEventListener("resize", reposition); window.removeEventListener("scroll", reposition, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    /** Dismiss for another control without stealing that control's focus. */
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !menu.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const host = trigger.current?.closest<HTMLElement>("[data-theme]") ?? document.body;
  return <>
    <button ref={trigger} type="button" role="combobox" aria-label={label} aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? id : undefined} aria-activedescendant={open ? `${id}-${highlight}` : undefined} disabled={disabled}
      className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-sm px-2 py-1 text-xs text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
      title={selected?.description ?? label} onClick={() => open ? setOpen(false) : openMenu()}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
        else if (event.key === "Tab") setOpen(false);
        else if ((event.key === "Enter" || event.key === " ") && open) { event.preventDefault(); choose(highlight); }
        else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          if (!open) { openMenu(); return; }
          const enabled = choices.map((choice, index) => choice.disabled ? -1 : index).filter((index) => index >= 0);
          if (enabled.length === 0) return;
          const current = enabled.indexOf(highlight);
          setHighlight(event.key === "Home" ? enabled[0] : event.key === "End" ? enabled.at(-1)! : enabled[(current + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length]);
        }
      }}><span className="truncate">{selected?.label ?? value}</span><ChevronDown size={12} className="shrink-0 text-muted-foreground" aria-hidden="true" /></button>
    {open && createPortal(<div ref={menu} id={id} role="listbox" aria-label={label} className="fixed z-[70] overflow-y-auto rounded-md border border-border bg-card p-1 text-foreground shadow-xl"
      style={{ left: position.left, top: position.above ? undefined : position.top, bottom: position.above ? position.top : undefined, width: position.width, maxHeight: position.height }} onPointerDown={(event) => event.preventDefault()}>
      {choices.map((choice, index) => <div key={choice.value} id={`${id}-${index}`} role="option" aria-selected={choice.value === value} aria-disabled={choice.disabled || undefined}
        className={`flex cursor-pointer items-start gap-2 rounded-sm px-2 py-2 text-xs ${index === highlight ? "bg-muted" : "hover:bg-muted/70"} ${choice.disabled ? "opacity-50" : ""}`}
        onPointerMove={() => { if (!choice.disabled) setHighlight(index); }} onClick={() => choose(index)}>
        <Check size={14} className={`mt-0.5 shrink-0 ${choice.value === value ? "text-primary" : "invisible"}`} aria-hidden="true" />
        <span className="min-w-0"><span className="block break-words">{choice.label}</span>{choice.description && <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">{choice.description}</span>}</span>
      </div>)}
    </div>, host)}
  </>;
}
