import { useEffect, useId, useRef, useState } from "react";
import { Info } from "lucide-react";
import { useI18n } from "../i18n/I18nProvider";

/**
 * Supplementary explanation behind an info icon.
 *
 * Keeps help text off the screen until asked for: a click (or Enter/Space)
 * opens a small popover, and Escape, a second click or a click elsewhere
 * closes it. The text stays in the accessibility tree as the button's
 * description so screen readers still hear it.
 */
export function InfoHint({ text, className = "" }: { text: string; className?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    /** Close when a pointer goes down outside the hint. */
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <span ref={root} className={`relative inline-flex align-middle ${className}`}>
      <button
        type="button"
        aria-label={t("補足")}
        aria-expanded={open}
        aria-describedby={id}
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpen((value) => !value); }}
        onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}
        className="inline-flex rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
      >
        <Info size={13} aria-hidden="true" />
      </button>
      <span
        id={id}
        role="tooltip"
        className={open
          ? "absolute left-0 top-full z-50 mt-1 w-64 rounded-md border border-border bg-card p-2 text-left text-xs font-normal leading-5 text-foreground shadow-lg"
          : "sr-only"}
      >
        {text}
      </span>
    </span>
  );
}
