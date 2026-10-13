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
    <div data-testid="tabs" aria-label="タブ" role="tablist" className="flex flex-wrap gap-1">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tab"
          aria-selected={activeId === tab.id}
          className={`flex items-center gap-2 rounded-t-lg border border-b-0 border-border px-3 py-2 text-sm ${activeId === tab.id ? "bg-card font-medium" : "bg-muted/50"}`}
        >
          <button type="button" onClick={() => onSelect(tab.id)} className="max-w-40 truncate">
            {tab.label}
            {tab.dirty ? " ●" : ""}
          </button>
          <button type="button" onClick={() => onClose(tab.id)} aria-label={`${tab.label}を閉じる`} className="rounded px-1 text-muted-foreground hover:bg-muted">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
