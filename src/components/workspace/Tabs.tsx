interface Props {
  tabs: string[];
  active: string | null;
  dirty: Record<string, boolean>;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}

export function Tabs({ tabs, active, dirty, onSelect, onClose }: Props) {
  return (
    <div data-testid="tabs" aria-label="タブ" role="tablist" className="flex flex-wrap gap-1">
      {tabs.map((path) => (
        <div
          key={path}
          role="tab"
          aria-selected={active === path}
          className={`flex items-center gap-2 rounded-t-lg border border-b-0 border-border px-3 py-2 text-sm ${active === path ? "bg-card font-medium" : "bg-muted/50"}`}
        >
          <button type="button" onClick={() => onSelect(path)} className="max-w-40 truncate">
            {path.split("/").pop()}
            {dirty[path] ? " ●" : ""}
          </button>
          <button type="button" onClick={() => onClose(path)} aria-label={`${path}を閉じる`} className="rounded px-1 text-muted-foreground hover:bg-muted">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
