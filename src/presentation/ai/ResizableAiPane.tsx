import { useEffect, useRef, useState, type ReactNode } from "react";
import { AI_CHAT_WIDTH, clampAiChatWidth } from "../../domain/ai-view-preferences";
import { useI18n } from "../i18n/I18nProvider";

interface Props {
  visible: boolean;
  width: number;
  /** Persist the user's requested width; viewport clamping remains temporary. */
  onWidth: (width: number) => void;
  children: ReactNode;
}

/** Resize the right chat with pointer capture or keyboard without losing its mounted conversation. */
export function ResizableAiPane({ visible, width, onWidth, children }: Props) {
  const { t } = useI18n();
  const pane = useRef<HTMLElement>(null);
  const drag = useRef<{ pointer: number; x: number; width: number } | null>(null);
  const [available, setAvailable] = useState(Infinity);
  const effectiveWidth = clampAiChatWidth(width, available);
  const min = clampAiChatWidth(AI_CHAT_WIDTH.min, available);
  const max = clampAiChatWidth(AI_CHAT_WIDTH.max, available);
  useEffect(() => {
    /** Recompute available workspace width without rewriting a persisted wider preference. */
    function measure() {
      const parent = pane.current?.parentElement;
      const measured = parent?.getBoundingClientRect().width;
      const fixed = parent ? Array.from(parent.children).reduce((total, sibling) => {
        if (sibling === pane.current) return total;
        const style = getComputedStyle(sibling);
        return style.display !== "none" && style.position !== "absolute" && style.position !== "fixed" && Number(style.flexGrow) === 0 ? total + sibling.getBoundingClientRect().width : total;
      }, 0) : 0;
      setAvailable(Math.max(0, (measured && measured > 0 ? measured : window.innerWidth) - fixed));
    }
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    if (pane.current?.parentElement) observer?.observe(pane.current.parentElement);
    for (const sibling of Array.from(pane.current?.parentElement?.children ?? [])) if (sibling !== pane.current) observer?.observe(sibling);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [visible]);
  return <aside ref={pane} data-testid="ai-sidebar" aria-label={t("AI サイドバー")} aria-hidden={!visible} className={visible ? "marxen-ai-sidebar relative flex min-w-0 shrink-0 flex-col border-l border-border bg-card max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-30" : "hidden"} style={{ width: effectiveWidth }}>
    <div role="separator" aria-label={t("チャットの幅を変更")} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={effectiveWidth} aria-valuetext={`${effectiveWidth}px`} tabIndex={visible ? 0 : -1} title={t("ドラッグか左右キーで幅を変更。Home / End で最小 / 最大、ダブルクリックでリセット。")}
      className="absolute -left-1 top-0 z-20 h-full w-2 cursor-col-resize touch-none select-none hover:bg-primary/40 focus-visible:bg-primary/40 focus-visible:outline-2 focus-visible:outline-primary"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault(); event.currentTarget.focus();
        drag.current = { pointer: event.pointerId, x: event.clientX, width: effectiveWidth };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => { if (drag.current && drag.current.pointer === event.pointerId) onWidth(clampAiChatWidth(drag.current.width + drag.current.x - event.clientX, available)); }}
      onPointerUp={(event) => { if (drag.current?.pointer === event.pointerId) { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); } }}
      onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
      onDoubleClick={() => onWidth(AI_CHAT_WIDTH.default)}
      onKeyDown={(event) => {
        const step = AI_CHAT_WIDTH.step * (event.shiftKey ? 4 : 1);
        const next = event.key === "ArrowLeft" ? effectiveWidth + step : event.key === "ArrowRight" ? effectiveWidth - step : event.key === "Home" ? min : event.key === "End" ? max : event.key === "Enter" ? AI_CHAT_WIDTH.default : null;
        if (next === null) return;
        event.preventDefault(); event.stopPropagation(); onWidth(clampAiChatWidth(next, available));
      }} />
    {children}
  </aside>;
}
