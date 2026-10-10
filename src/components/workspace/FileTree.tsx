interface Props {
  files: string[];
  active: string | null;
  onOpen: (path: string) => void;
}

export function FileTree({ files, active, onOpen }: Props) {
  return (
    <nav data-testid="file-tree" aria-label="フォルダーツリー" className="overflow-auto">
      <p className="px-3 pb-2 text-xs font-semibold tracking-wider text-muted-foreground">エクスプローラー</p>
      <ul className="space-y-1 px-2">
        {files.map((path) => (
          <li key={path}>
            <button
              type="button"
              onClick={() => onOpen(path)}
              aria-current={active === path ? "true" : undefined}
              className={`w-full truncate rounded-md px-3 py-2 text-left text-sm hover:bg-muted ${active === path ? "bg-muted font-medium" : ""}`}
            >
              {path}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
