import { useI18n } from "../i18n/I18nProvider";
import { useEffect, useRef, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Dismiss the popover and return focus to its trigger. */
  onClose: () => void;
}

/** Anchored editor operations with outside dismissal and keyboard navigation. */
export function EditorActionsPopover({ children, onClose }: Props) {
  const { t } = useI18n();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
    /** Close only for pointer events outside this panel and its toggle button. */
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && !panel.current?.contains(target) && !target.closest('[data-editor-actions-trigger]')) close.current();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => { document.removeEventListener("pointerdown", dismiss); previous?.focus(); };
  }, []);
  return <div ref={panel} role="dialog" aria-label={t("エディター操作")} className="absolute right-2 top-10 z-20 max-h-[calc(100dvh-96px)] w-64 overflow-y-auto rounded-sm border border-border bg-card p-1 shadow-xl"
    onKeyDown={(event) => {
      if (event.key === "Escape" || event.key === "Tab") {
        if (event.key === "Escape") event.preventDefault();
        event.stopPropagation(); close.current();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []);
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    }}>{children}</div>;
}
