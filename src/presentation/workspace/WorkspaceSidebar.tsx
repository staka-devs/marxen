import { useRef, useState, type ReactNode } from "react";

/** Explorer pane with pointer and keyboard resizing kept in presentation state. */
export function WorkspaceSidebar({ children }: { children: ReactNode }) {
  const [width, setWidth] = useState(240);
  const drag = useRef<{ x: number; width: number } | null>(null);
  return <>
    <aside style={{ width }} className="marxen-sidebar absolute inset-y-0 left-12 z-20 flex shrink-0 flex-col overflow-y-auto border-r border-border bg-card shadow-xl md:static md:z-auto md:shadow-none" aria-label="サイドバー">{children}</aside>
    <div role="separator" tabIndex={0} aria-label="サイドバーの幅" aria-orientation="vertical" aria-valuemin={180} aria-valuemax={420} aria-valuenow={width}
      className="relative z-10 -ml-0.5 hidden w-1 shrink-0 cursor-col-resize touch-none hover:bg-primary focus:bg-primary focus:outline-none md:block"
      onPointerDown={(event) => { if (event.button !== 0) return; drag.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={(event) => { if (drag.current) setWidth(Math.max(180, Math.min(420, drag.current.width + event.clientX - drag.current.x))); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
      onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setWidth((value) => Math.max(180, Math.min(420, value + (event.key === "ArrowLeft" ? -10 : 10)))); } }} />
  </>;
}
