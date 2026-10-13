import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

/** A real selectable value and its user-facing purpose. */
export interface Choice {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  icon?: ReactNode;
  group?: string;
}

interface Props {
  label: string;
  value: string;
  choices: readonly Choice[];
  disabled?: boolean;
  searchLabel?: string;
  emptyLabel?: string;
  valueLabel?: string;
  valueIcon?: ReactNode;
  /** Commit the chosen value without interpreting provider identifiers. */
  onChange: (value: string) => void;
}

/** Compact, themed selection with a readable popup and keyboard navigation. */
export function ChoiceMenu({ label, value, choices, disabled, onChange, searchLabel, emptyLabel, valueLabel, valueIcon }: Props) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [position, setPosition] = useState({ left: 8, top: 8, width: 320, height: 320, above: false });
  const selected = choices.find((choice) => choice.value === value);
  const filtered = choices.map((choice, index) => ({ choice, index })).filter(({ choice }) => `${choice.label} ${choice.value} ${choice.description ?? ""} ${choice.group ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  /** Open at the selected choice while leaving focus on the combobox. */
  function openMenu() {
    setQuery("");
    const index = choices.findIndex((choice) => choice.value === value && !choice.disabled);
    setHighlight(index >= 0 ? index : Math.max(0, choices.findIndex((choice) => !choice.disabled)));
    setOpen(true); trigger.current?.focus();
  }
  /** Navigate filtered enabled options while keeping search text editable. */
  function handleKey(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    else if (event.key === "Tab") { if (event.target === search.current) trigger.current?.focus(); setOpen(false); }
    else if ((event.key === "Enter" || (event.key === " " && event.target === trigger.current)) && open) { event.preventDefault(); choose(highlight); }
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && (event.target === trigger.current || !["Home", "End"].includes(event.key))) {
      event.preventDefault();
      if (!open) { openMenu(); return; }
      const enabled = filtered.filter(({ choice }) => !choice.disabled).map(({ index }) => index);
      if (enabled.length === 0) return;
      const current = enabled.indexOf(highlight);
      setHighlight(event.key === "Home" ? enabled[0] : event.key === "End" ? enabled.at(-1)! : enabled[(current + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length]);
    }
  }
  /** Commit only enabled advertised choices and close the popup. */
  function choose(index: number) {
    const choice = choices[index];
    if (!choice || choice.disabled || !filtered.some((item) => item.index === index)) return;
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
  useEffect(() => { if (open && searchLabel) search.current?.focus(); }, [open, searchLabel]);
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>(`[id="${id}-${highlight}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, highlight, id]);
  const host = trigger.current?.closest<HTMLElement>("[data-theme]") ?? document.body;
  return <>
    <button ref={trigger} type="button" role="combobox" aria-label={label} aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? id : undefined} aria-activedescendant={open && filtered.some(({ index }) => index === highlight) ? `${id}-${highlight}` : undefined} disabled={disabled}
      className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-sm px-2 py-1 text-xs text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
      title={selected?.description ?? label} onClick={() => open ? setOpen(false) : openMenu()}
      onKeyDown={handleKey}>{(selected?.icon ?? valueIcon) && <span className="shrink-0">{selected?.icon ?? valueIcon}</span>}<span className="truncate">{selected?.label ?? valueLabel ?? value}</span><ChevronDown size={12} className="shrink-0 text-muted-foreground" aria-hidden="true" /></button>
    {open && createPortal(<div ref={menu} className="fixed z-[70] flex flex-col overflow-hidden rounded-md border border-border bg-card p-1 text-foreground shadow-xl"
      style={{ left: position.left, top: position.above ? undefined : position.top, bottom: position.above ? position.top : undefined, width: position.width, maxHeight: position.height }}>
      {searchLabel && <input ref={search} role="combobox" aria-label={searchLabel} aria-expanded="true" aria-controls={id} aria-activedescendant={filtered.some(({ index }) => index === highlight) ? `${id}-${highlight}` : undefined} className="m-1 min-w-0 shrink-0 rounded-sm border border-border bg-card px-2 py-1.5 text-xs outline-none focus:border-primary" value={query} placeholder={searchLabel} onKeyDown={handleKey} onChange={(event) => {
        const next = event.target.value; setQuery(next);
        setHighlight(choices.findIndex((choice) => !choice.disabled && `${choice.label} ${choice.value} ${choice.description ?? ""} ${choice.group ?? ""}`.toLocaleLowerCase().includes(next.trim().toLocaleLowerCase())));
      }} />}
      <div id={id} role="listbox" aria-label={label} className="min-h-0 overflow-y-auto" onPointerDown={(event) => event.preventDefault()}>
      {filtered.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground" role="status">{emptyLabel}</p>}
      {filtered.map(({ choice, index }, filteredIndex) => <div key={choice.value}>
      {choice.group && choice.group !== filtered[filteredIndex - 1]?.choice.group && <div className="px-2 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">{choice.group}</div>}
      <div id={`${id}-${index}`} role="option" aria-label={choice.label} aria-description={choice.description} aria-selected={choice.value === value} aria-disabled={choice.disabled || undefined}
        className={`flex cursor-pointer items-start gap-2 rounded-sm px-2 py-2 text-xs ${index === highlight ? "bg-muted" : "hover:bg-muted/70"} ${choice.disabled ? "opacity-50" : ""}`}
        onPointerMove={() => { if (!choice.disabled) setHighlight(index); }} onClick={() => choose(index)}>
        <Check size={14} className={`mt-0.5 shrink-0 ${choice.value === value ? "text-primary" : "invisible"}`} aria-hidden="true" />
        {choice.icon && <span className="mt-0.5 shrink-0">{choice.icon}</span>}
        <span className="min-w-0"><span className="block break-words">{choice.label}</span>{choice.description && <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">{choice.description}</span>}</span>
      </div></div>)}
      </div>
    </div>, host)}
  </>;
}
