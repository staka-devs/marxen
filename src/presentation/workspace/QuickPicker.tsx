import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";

export interface PickerItem {
  id: string;
  label: string;
  detail?: string;
  icon?: ReactNode;
  accessibleLabel?: string;
}
interface Props {
  label: string;
  inputLabel: string;
  placeholder: string;
  testId: string;
  query: string;
  items: PickerItem[];
  emptyText: string;
  /** Change the filter and reset the highlighted result. */
  onQuery: (query: string) => void;
  /** Execute the selected item after dismissing the picker. */
  onSelect: (id: string) => void;
  /** Close without executing an item. */
  onClose: () => void;
}

/** Search picker shared by file and command navigation, with arrow selection and focus restoration. */
export function QuickPicker({ label, inputLabel, placeholder, testId, query, items, emptyText, onQuery, onSelect, onClose }: Props) {
  const [index, setIndex] = useState(0);
  const resultsId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const active = Math.min(index, Math.max(0, items.length - 1));
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = panel.current;
    input.current?.focus();
    return () => { if (element?.contains(document.activeElement) || document.activeElement === document.body) previous?.focus(); };
  }, []);
  useEffect(() => {
    panel.current?.querySelectorAll('[role="option"]')[active]?.scrollIntoView?.({ block: "nearest" });
  }, [active, items]);
  /** Dismiss before executing so an action may safely focus its next dialog. */
  const choose = (id: string) => { onClose(); onSelect(id); };
  return <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/20 px-4 pt-[min(12dvh,90px)]" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panel} role="dialog" aria-modal="true" aria-label={label} data-testid={testId} className="flex max-h-[75dvh] w-full max-w-xl flex-col overflow-hidden rounded-md border border-border bg-card shadow-2xl"
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
        if (event.key === "Tab") { event.preventDefault(); (document.activeElement === input.current ? closeButton.current : input.current)?.focus(); }
      }}>
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <Search size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />
        <input ref={input} role="combobox" aria-expanded="true" aria-controls={resultsId} aria-autocomplete="list" aria-activedescendant={items.length ? `${resultsId}-${active}` : undefined}
          aria-label={inputLabel} placeholder={placeholder} value={query} className="marxen-picker-input min-w-0 flex-1 bg-transparent text-[13px] outline-none"
          onChange={(event) => { setIndex(0); onQuery(event.target.value); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setIndex((active + (event.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(1, items.length)); }
            else if (event.key === "Enter" && items[active]) { event.preventDefault(); choose(items[active].id); }
          }} />
        <button ref={closeButton} type="button" aria-label={`${label}を閉じる`} title="閉じる (Esc)" onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted"><X size={15} /></button>
      </div>
      <ul id={resultsId} role="listbox" aria-label={label} className="min-h-0 overflow-y-auto p-1">
        {items.map((item, position) => <li key={item.id} id={`${resultsId}-${position}`} role="option" aria-selected={position === active}>
          <button type="button" tabIndex={-1} aria-label={item.accessibleLabel} title={item.accessibleLabel} onPointerMove={() => setIndex(position)} onClick={() => choose(item.id)} className={`flex h-9 w-full min-w-0 items-center gap-2.5 rounded px-3 text-left text-[13px] ${position === active ? "bg-primary/10 text-foreground" : "hover:bg-muted/50"}`}>
            {item.icon}<span className="shrink-0 max-w-[65%] truncate">{item.label}</span><span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.detail}</span>
          </button>
        </li>)}
        {items.length === 0 && <li className="px-4 py-5 text-xs text-muted-foreground">{emptyText}</li>}
      </ul>
      <div className="flex h-7 shrink-0 items-center gap-4 border-t border-border px-4 text-[10px] text-muted-foreground"><span>↑ ↓ 選択</span><span>Enter 開く</span><span>Esc 閉じる</span></div>
    </div>
  </div>;
}
