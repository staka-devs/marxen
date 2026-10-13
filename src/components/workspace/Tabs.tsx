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
    <div data-testid="tabs" aria-label="タブ" role="tablist" className="flex h-[36px] items-end gap-1 overflow-x-auto px-1">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tab"
          aria-selected={activeId === tab.id}
          className={`flex h-[30px] shrink-0 items-center gap-1.5 rounded-t-md border border-b-0 border-border px-2 text-xs ${activeId === tab.id ? "bg-card font-medium" : "bg-muted/50"}`}
        >
          <button type="button" onClick={() => onSelect(tab.id)} className="max-w-32 truncate">
            {tab.label}
            {tab.dirty ? " ●" : ""}
          </button>
          <button type="button" onClick={() => onClose(tab.id)} aria-label={`${tab.label}を閉じる`} className="rounded px-0.5 text-muted-foreground hover:bg-muted">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
