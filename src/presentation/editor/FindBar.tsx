import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CaseSensitive, ChevronRight, Regex, Replace, ReplaceAll, WholeWord, X } from "lucide-react";
import { useI18n } from "../i18n/I18nProvider";
import type { SearchOptions } from "../../contracts/contracts";
import type { SearchHitItem } from "../../domain/search-hit";

interface Props {
  query: string;
  /** Replace the search text. */
  onQuery: (query: string) => void;
  options: SearchOptions;
  /** Toggle case, whole-word or regex matching. */
  onOptions: (options: SearchOptions) => void;
  hits: SearchHitItem[];
  searching: boolean;
  ready: boolean;
  error: string | null;
  replaceText: string;
  /** Replace the replacement text. */
  onReplaceText: (text: string) => void;
  /** Move the editor to one exact match. */
  onJump: (hit: SearchHitItem) => void;
  /** Replace one exact match. */
  onReplaceOne: (hit: SearchHitItem) => void;
  /** Replace every match in this file. */
  onReplaceAll: () => void;
  /** Close and return focus to the editor. */
  onClose: () => void;
}

/** In-file find and replace bar over the editor (VS Code's find widget). */
export function FindBar({ query, onQuery, options, onOptions, hits, searching, ready, error, replaceText, onReplaceText, onJump, onReplaceOne, onReplaceAll, onClose }: Props) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [index, setIndex] = useState(0);
  const [replacing, setReplacing] = useState(false);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  useEffect(() => { setIndex(0); }, [query, options.caseSensitive, options.wholeWord, options.regex]);
  const current = hits.length > 0 ? Math.min(index, hits.length - 1) : -1;
  /** Step to the next or previous match, wrapping around, and show it. */
  const step = (delta: number) => {
    if (hits.length === 0 || !ready) return;
    const next = (current + delta + hits.length) % hits.length;
    setIndex(next);
    onJump(hits[next]);
  };
  const toggles: Array<[keyof SearchOptions, string, typeof CaseSensitive]> = [
    ["caseSensitive", t("大文字と小文字を区別"), CaseSensitive], ["wholeWord", t("単語単位"), WholeWord], ["regex", t("正規表現"), Regex],
  ];
  const iconButton = "rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 aria-pressed:bg-primary/15 aria-pressed:text-foreground";
  return (
    <div role="search" aria-label={t("ファイル内を検索")} className="marxen-find-bar absolute right-4 top-1 z-20 flex w-[min(28rem,calc(100%-2rem))] gap-1 rounded-md border border-border bg-card p-1 shadow-lg"
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
        else if (event.key === "Enter" && event.target === input.current) { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
      }}>
      <button type="button" aria-label={t("置換の切り替え")} aria-expanded={replacing} onClick={() => setReplacing((value) => !value)} className={iconButton}>
        <ChevronRight size={14} aria-hidden="true" className={replacing ? "rotate-90" : ""} />
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-1">
          <input ref={input} aria-label={t("検索")} placeholder={t("検索")} value={query} onChange={(event) => onQuery(event.target.value)} className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-2 text-[13px] outline-none focus:border-primary" />
          {toggles.map(([key, label, Icon]) => (
            <button key={key} type="button" aria-label={label} title={label} aria-pressed={options[key]} onClick={() => onOptions({ ...options, [key]: !options[key] })} className={iconButton}>
              <Icon size={14} aria-hidden="true" />
            </button>
          ))}
          <span role="status" className="w-16 shrink-0 text-center text-[11px] text-muted-foreground tabular-nums">
            {error ? t("エラー") : searching ? "…" : query === "" ? "" : hits.length === 0 ? t("結果なし") : `${current + 1} / ${hits.length}`}
          </span>
          <button type="button" aria-label={t("前の一致")} title={t("前の一致 (Shift+Enter)")} disabled={hits.length === 0 || !ready} onClick={() => step(-1)} className={iconButton}><ArrowUp size={14} aria-hidden="true" /></button>
          <button type="button" aria-label={t("次の一致")} title={t("次の一致 (Enter)")} disabled={hits.length === 0 || !ready} onClick={() => step(1)} className={iconButton}><ArrowDown size={14} aria-hidden="true" /></button>
          <button type="button" aria-label={t("閉じる")} title={t("閉じる (Esc)")} onClick={onClose} className={iconButton}><X size={14} aria-hidden="true" /></button>
        </div>
        {replacing && (
          <div className="flex items-center gap-1">
            <input aria-label={t("置換")} placeholder={t("置換")} value={replaceText} onChange={(event) => onReplaceText(event.target.value)} className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-2 text-[13px] outline-none focus:border-primary" />
            <button type="button" aria-label={t("置換")} title={t("置換")} disabled={current < 0 || !ready} onClick={() => onReplaceOne(hits[current])} className={iconButton}><Replace size={14} aria-hidden="true" /></button>
            <button type="button" aria-label={t("すべて置換")} title={t("すべて置換")} disabled={hits.length === 0 || !ready} onClick={onReplaceAll} className={iconButton}><ReplaceAll size={14} aria-hidden="true" /></button>
          </div>
        )}
        {error && <p role="alert" className="px-1 text-[11px] text-red-600">{error}</p>}
      </div>
    </div>
  );
}
