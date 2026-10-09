import { useMemo, useState } from "react";
import { filterPaths } from "../../domain/workspace-content";

interface Props {
  open: boolean;
  paths: string[];
  label: string;
  testId: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

/** Fuzzy file quick-open dialog, closing on select. */ export function QuickOpen({ open, paths, label, testId, onSelect, onClose }: Props) {
  const [query, setQuery] = useState("");
  const hits = useMemo(() => filterPaths(paths, query).slice(0, 20), [paths, query]);
  if (!open) return null;
  return (
    <div data-testid={testId} role="dialog" aria-label={label} className="absolute inset-x-0 top-12 z-20 mx-auto max-w-lg rounded-lg border border-border bg-card p-3 shadow-lg">
      <input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="ファイル名を入力…"
        aria-label="ファイル名で絞り込む"
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
      />
      <ul className="mt-2 max-h-60 overflow-auto">
        {hits.map((path) => (
          <li key={path}>
            <button
              type="button"
              onClick={() => {
                onSelect(path);
                setQuery("");
                onClose();
              }}
              className="w-full truncate rounded px-3 py-2 text-left text-sm hover:bg-muted"
            >
              {path}
            </button>
          </li>
        ))}
        {hits.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">一致するファイルがありません</li>}
      </ul>
      <button type="button" onClick={onClose} className="mt-2 w-full rounded-md border border-border px-3 py-1 text-xs text-muted-foreground">
        閉じる (Esc)
      </button>
    </div>
  );
}

