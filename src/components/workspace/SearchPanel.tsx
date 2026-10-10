import { useMemo, useState } from "react";
import { searchWorkspace, type WorkspaceFile } from "../../lib/workspace";

interface Props {
  files: WorkspaceFile[];
  onJump: (path: string, line: number) => void;
}

export function SearchPanel({ files, onJump }: Props) {
  const [query, setQuery] = useState("");
  const hits = useMemo(() => searchWorkspace(files, query, 50), [files, query]);
  return (
    <section data-testid="search-panel" aria-label="全文検索" className="border-t border-border p-3">
      <p className="mb-2 text-xs font-semibold tracking-wider text-muted-foreground">検索</p>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="検索語句…"
        aria-label="検索語句"
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
      />
      <ul className="mt-2 max-h-48 space-y-1 overflow-auto">
        {hits.map((hit, index) => (
          <li key={`${hit.path}:${hit.line}:${hit.col}:${index}`}>
            <button type="button" onClick={() => onJump(hit.path, hit.line)} className="w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-muted">
              {hit.path}:{hit.line + 1} {hit.preview}
            </button>
          </li>
        ))}
      </ul>
      {query !== "" && <p className="mt-1 text-xs text-muted-foreground">{hits.length} 件</p>}
    </section>
  );
}
