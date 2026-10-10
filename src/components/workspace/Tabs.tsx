import { FileText, Image, X } from "lucide-react";
import { isImagePath } from "../../lib/workspace-files";

export interface TabItem {
  id: string;
  label: string;
  dirty: boolean;
}

interface Props {
  tabs: TabItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

export function Tabs({ tabs, activeId, onSelect, onClose }: Props) {
  return (
    <div data-testid="tabs" aria-label="タブ" role="tablist" className="flex h-9 min-w-0 overflow-x-auto">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tab"
          aria-selected={activeId === tab.id}
          className={`group flex h-9 min-w-28 shrink-0 items-center gap-2 border-r border-t border-r-border px-3 text-[13px] ${activeId === tab.id ? "border-t-primary bg-background text-foreground" : "border-t-transparent text-muted-foreground hover:bg-muted"}`}
        >
          <button type="button" onClick={() => onSelect(tab.id)} className="flex min-w-0 max-w-44 flex-1 items-center gap-2" title={tab.label}>
            {isImagePath(tab.label) ? <Image size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" /> : <FileText size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
            <span className="truncate">{tab.label}</span>
            {tab.dirty && <span className="sr-only"> ●</span>}
          </button>
          <button type="button" onClick={() => onClose(tab.id)} aria-label={`${tab.label}を閉じる`} className="group/close relative flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted">
            {tab.dirty && <span aria-hidden="true" className="absolute h-1.5 w-1.5 rounded-full bg-foreground group-hover:hidden" />}
            <X size={13} aria-hidden="true" className={tab.dirty ? "opacity-0 group-hover:opacity-100 group-focus-visible/close:opacity-100" : "opacity-60 group-hover:opacity-100"} />
          </button>
        </div>
      ))}
    </div>
  );
}
