export interface SearchHitItem {
  path: string;
  line: number;
  col: number;
  preview: string;
  documentId?: string | null;
  revision?: number | null;
  /** Global UTF-16 offset of the match start (registry matches). */
  offset?: number;
  /** Global UTF-16 offset of the match end. */
  end?: number;
}

interface Props {
  query: string;
  onQuery: (query: string) => void;
  hits: SearchHitItem[];
  searching: boolean;
  canReplace: boolean;
  replaceText: string;
  onReplaceText: (text: string) => void;
  onJump: (hit: SearchHitItem) => void;
  onReplaceOne: (hit: SearchHitItem) => void;
  onReplaceAll: () => void;
}

export function SearchPanel({ query, onQuery, hits, searching, canReplace, replaceText, onReplaceText, onJump, onReplaceOne, onReplaceAll }: Props) {
  return (
    <section data-testid="search-panel" aria-label="全文検索" className="border-t border-border p-3">
      <p className="mb-2 text-xs font-semibold tracking-wider text-muted-foreground">検索</p>
      <input
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        placeholder="検索語句…"
        aria-label="検索語句"
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
      />
      {canReplace && (
        <div className="mt-2 flex gap-2">
          <input
            value={replaceText}
            onChange={(event) => onReplaceText(event.target.value)}
            placeholder="置換後…"
            aria-label="置換後の文字列"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <button type="button" onClick={onReplaceAll} disabled={query === ""} aria-label="すべて置換する" className="rounded-md border border-border px-3 py-1 text-xs disabled:opacity-50">
            一括置換
          </button>
        </div>
      )}
      <ul className="mt-2 max-h-48 space-y-1 overflow-auto">
        {hits.map((hit, index) => (
          <li key={`${hit.path}:${hit.line}:${hit.col}:${index}`} className="flex items-center gap-1">
            <button type="button" onClick={() => onJump(hit)} className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-xs hover:bg-muted">
              {hit.path}:{hit.line + 1} {hit.preview}
            </button>
            {canReplace && (
              <button type="button" onClick={() => onReplaceOne(hit)} aria-label={`${hit.path}の一致を置換する`} className="shrink-0 rounded border border-border px-2 py-1 text-xs">
                置換
              </button>
            )}
          </li>
        ))}
      </ul>
      {query !== "" && <p className="mt-1 text-xs text-muted-foreground">{searching ? "検索中…" : `${hits.length} 件`}</p>}
    </section>
  );
}
