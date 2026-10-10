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
          className={`flex h-9 shrink-0 items-center gap-3 border-r border-t-2 border-r-border px-3 text-xs ${activeId === tab.id ? "border-t-primary bg-background text-foreground" : "border-t-transparent text-muted-foreground hover:bg-muted"}`}
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
