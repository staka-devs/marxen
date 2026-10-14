import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileText } from "lucide-react";
import { useI18n } from "../i18n/I18nProvider";
import type { SearchHitItem } from "../../domain/search-hit";
import type { SearchLimit, SearchOptions } from "../../contracts/contracts";

interface Props {
  query: string;
  /** Replace the search query. */
  onQuery: (query: string) => void;
  hits: SearchHitItem[];
  searching: boolean;
  canReplace: boolean;
  replaceText: string;
  /** Replace literal replacement text; empty text deletes the match. */
  onReplaceText: (text: string) => void;
  /** Validate and navigate one exact authoritative result. */
  onJump: (hit: SearchHitItem) => void;
  /** Replace one exact authoritative result. */
  onReplaceOne: (hit: SearchHitItem) => void;
  /** Replace the complete captured native result set. */
  onReplaceAll: () => void;
  searchOptions: SearchOptions;
  /** Update native matching options. */
  onSearchOptions: (options: SearchOptions) => void;
  searchError: string | null;
  searchLimit: SearchLimit | null;
  resultsReady: boolean;
  replacing: boolean;
}

/** Group exact native hits by file, retaining first-seen order from the audited panel. */
function groupHits(hits: SearchHitItem[]) {
  const groups = new Map<string, SearchHitItem[]>();
  for (const hit of hits) {
    const list = groups.get(hit.path) ?? [];
    list.push(hit);
    groups.set(hit.path, list);
  }
  return [...groups].map(([path, items]) => {
    const parts = path.split("/");
    const base = parts.pop() ?? path;
    return { path, base, dir: parts.join("/"), hits: items };
  });
}

/** Display this hit's native preview span without renderer regex evaluation. */
function PreviewLine({ hit }: { hit: SearchHitItem }) {
  const { t } = useI18n();
  const range = hit.previewRange;
  if (!range) return <span>{hit.preview}</span>;
  return <span className="whitespace-pre-wrap">{hit.preview.slice(0, range.start)}<mark className="bg-amber-300/30 text-foreground">{range.start === range.end ? <span aria-label={t("空の一致")}>│</span> : hit.preview.slice(range.start, range.end)}</mark>{hit.preview.slice(range.end)}</span>;
}

/** Grouped search with visible-row navigation and guarded native replacement. */
export function SearchPanel({ query, onQuery, hits, searching, canReplace, replaceText, onReplaceText, onJump, onReplaceOne, onReplaceAll, searchOptions, onSearchOptions, searchError, searchLimit, resultsReady, replacing }: Props) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const rows = useRef(new Map<SearchHitItem, HTMLButtonElement>());
  const groups = useMemo(() => groupHits(hits), [hits]);
  const visible = useMemo(() => groups.flatMap((group) => collapsed.has(group.path) ? [] : group.hits), [groups, collapsed]);
  const busy = searching || replacing;
  const actionsEnabled = canReplace ? resultsReady && !busy && !searchError : !busy;
  useEffect(() => { setCollapsed(new Set()); }, [query, searchOptions]);

  /** Move actual focus only among mounted, expanded result buttons. */
  function navigate(event: React.KeyboardEvent<HTMLButtonElement>, hit: SearchHitItem) {
    if (event.target !== event.currentTarget || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = visible.indexOf(hit);
    const next = event.key === "Home" ? 0 : event.key === "End" ? visible.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length;
    rows.current.get(visible[next])?.focus();
  }

  return (
    <section data-testid="search-panel" aria-label={t("全文検索")} className="px-3 pb-3">
      <p className="flex h-9 items-center text-[11px] font-medium text-muted-foreground">{t("検索")}</p>
      <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder={t("検索語句…")} aria-label={t("検索語句")} className="h-7 w-full rounded-sm border border-border bg-background px-2 text-xs" />
      <div className="mt-1 flex gap-1" role="group" aria-label={t("検索オプション")}>
        <button type="button" disabled={!canReplace} aria-pressed={searchOptions.caseSensitive} aria-label={t("大文字と小文字を区別")} onClick={() => onSearchOptions({ ...searchOptions, caseSensitive: !searchOptions.caseSensitive })} className="rounded border border-border px-2 text-xs aria-pressed:bg-muted disabled:opacity-50">{t("Aa")}</button>
        <button type="button" disabled={!canReplace} aria-pressed={searchOptions.wholeWord} aria-label={t("単語単位で検索")} onClick={() => onSearchOptions({ ...searchOptions, wholeWord: !searchOptions.wholeWord })} className="rounded border border-border px-2 text-xs aria-pressed:bg-muted disabled:opacity-50">{t("単語")}</button>
        <button type="button" disabled={!canReplace} aria-pressed={searchOptions.regex} aria-label={t("正規表現で検索")} onClick={() => onSearchOptions({ ...searchOptions, regex: !searchOptions.regex })} className="rounded border border-border px-2 text-xs aria-pressed:bg-muted disabled:opacity-50">.*</button>
      </div>
      {canReplace ? <details className="mt-1 text-[10px] text-muted-foreground"><summary>{t("一致規則と上限")}</summary><p>{t("Rust regex 1.13.1 の構文を使用します。後読み・先読みと後方参照は未対応です。Unicode の単語と単純ケースフォールドを使用し、^ と $ は各行に一致します。置換文字列はそのまま挿入します。")}</p><p>{t("上限: パターン 4096 バイト、深さ 64、コンパイル 1 MiB、1 ファイル 1 MiB、合計 32 MiB、2000 ファイル・一致、10000 候補/ファイル、5000 項目、2 秒（処理間で確認）。")}</p></details> : <p className="mt-1 text-[10px] text-muted-foreground">{t("ブラウザのサンプルは大文字小文字を区別する文字列検索のみです。")}</p>}
      {canReplace && <div className="mt-2 flex gap-1">
        <input value={replaceText} onChange={(event) => onReplaceText(event.target.value)} placeholder={t("置換後…")} aria-label={t("置換後の文字列")} className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-2 text-xs" />
        <button type="button" onClick={onReplaceAll} disabled={!actionsEnabled || !!searchLimit || hits.length === 0} aria-label={t("すべて置換する")} className="rounded border border-border px-2 text-xs disabled:opacity-50">{t("一括置換")}</button>
      </div>}
      {searchError && <p role="alert" className="mt-2 text-xs text-destructive">{searchError}</p>}
      {searchLimit && <p role="status" className="mt-2 text-xs text-muted-foreground">{t("検索を上限で打ち切りました。表示件数は全件数ではありません。一括置換には検索範囲を絞ってください。")}</p>}
      {query !== "" && <p className="mt-2 text-xs text-muted-foreground" role="status">{busy ? (replacing ? t("置換中…") : t("検索中…")) : searchLimit ? t("表示 {{count}} 件・{{files}} ファイル以上", { count: hits.length, files: groups.length }) : t("{{count}} 件・{{files}} ファイル", { count: hits.length, files: groups.length })}</p>}
      <ul className="mt-2 space-y-1">
        {groups.map((group) => <li key={group.path}>
          <button type="button" aria-expanded={!collapsed.has(group.path)} aria-label={t("{{path}} の一致を折りたたむ", { path: group.path })} onClick={() => setCollapsed((previous) => { const next = new Set(previous); if (next.has(group.path)) next.delete(group.path); else next.add(group.path); return next; })} className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-xs hover:bg-muted">
            {collapsed.has(group.path) ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}<FileText size={12} aria-hidden="true" /><span className="font-medium">{group.base}</span><span className="min-w-0 flex-1 truncate text-muted-foreground">{group.dir}</span><span>{group.hits.length}</span>
          </button>
          {!collapsed.has(group.path) && <ul className="ml-4 border-l border-border pl-1">
            {group.hits.map((hit, index) => <li key={`${hit.offset}:${index}`} className="flex gap-1">
              <button type="button" ref={(element) => { if (element) rows.current.set(hit, element); else rows.current.delete(hit); }} onKeyDown={(event) => navigate(event, hit)} onClick={() => { if (actionsEnabled) onJump(hit); }} disabled={!actionsEnabled} aria-label={t("{{path}} {{line}} 行目の一致へ移動", { path: hit.path, line: hit.line })} className="min-w-0 flex-1 rounded px-1 py-1 text-left text-xs hover:bg-muted focus:bg-muted disabled:opacity-50">
                <span className="mr-2 text-muted-foreground">{hit.line}</span><PreviewLine hit={hit} />
                {canReplace && <span className="mt-0.5 block text-muted-foreground">{t("置換後:")} {replaceText === "" ? <em>{t("削除")}</em> : <span className="whitespace-pre-wrap">{replaceText}</span>}</span>}
              </button>
              {canReplace && <button type="button" disabled={!actionsEnabled} onClick={() => onReplaceOne(hit)} aria-label={t("{{value0}}の一致を置換する", { value0: hit.path })} className="shrink-0 rounded px-1 text-xs disabled:opacity-50">{t("置換")}</button>}
            </li>)}
          </ul>}
        </li>)}
      </ul>
    </section>
  );
}
