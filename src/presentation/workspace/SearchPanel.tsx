import { useI18n } from "../i18n/I18nProvider";
import type { SearchHitItem } from "../../domain/search-hit";

interface Props {
  query: string;
  /** Replace the search query. */
  onQuery: (query: string) => void;
  hits: SearchHitItem[];
  searching: boolean;
  canReplace: boolean;
  replaceText: string;
  /** Replace the replacement text. */
  onReplaceText: (text: string) => void;
  /** Jump to a search hit opening the document when needed. */
  onJump: (hit: SearchHitItem) => void;
  /** Replace one hit revision-aware with resync on stale. */
  onReplaceOne: (hit: SearchHitItem) => void;
  /** Replace all registry hits per file with chained revisions. */
  onReplaceAll: () => void;
}

/** Full-text search panel with jump and revision-aware replace. */ export function SearchPanel({ query, onQuery, hits, searching, canReplace, replaceText, onReplaceText, onJump, onReplaceOne, onReplaceAll }: Props) {
  const { t } = useI18n();
  return (
    <section data-testid="search-panel" aria-label={t("全文検索")} className="px-3 pb-3">
      <p className="flex h-9 items-center text-[11px] font-medium text-muted-foreground">{t("検索")}</p>
      <input
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        placeholder={t("検索語句…")}
        aria-label={t("検索語句")}
        className="h-7 w-full rounded-sm border border-border bg-background px-2 text-xs"
      />
      {canReplace && (
        <div className="mt-2 flex gap-2">
          <input
            value={replaceText}
            onChange={(event) => onReplaceText(event.target.value)}
            placeholder={t("置換後…")}
            aria-label={t("置換後の文字列")}
            className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-2 text-xs"
          />
          <button type="button" onClick={onReplaceAll} disabled={query === ""} aria-label={t("すべて置換する")} className="rounded-md border border-border px-3 py-1 text-xs disabled:opacity-50">
            {t("一括置換")}</button>
        </div>
      )}
      <ul className="mt-2 space-y-1">
        {hits.map((hit, index) => (
          <li key={`${hit.path}:${hit.line}:${hit.col}:${index}`} className="flex items-center gap-1">
            <button type="button" onClick={() => onJump(hit)} className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-xs hover:bg-muted">
              {hit.path}:{hit.line + 1} {hit.preview}
            </button>
            {canReplace && (
              <button type="button" onClick={() => onReplaceOne(hit)} aria-label={t("{{value0}}の一致を置換する", { value0: (hit.path) })} className="shrink-0 rounded border border-border px-2 py-1 text-xs">
                {t("置換")}</button>
            )}
          </li>
        ))}
      </ul>
      {query !== "" && <p className="mt-1 text-xs text-muted-foreground">{searching ? t("検索中…") : t("{{count}} 件", { count: (hits.length) })}</p>}
    </section>
  );
}

