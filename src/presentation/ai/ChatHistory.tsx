import { intlLocale } from "../../domain/language";
import type { Translator } from "../../contracts/localization";
import { japaneseTranslator } from "../../domain/localization";
import { useI18n } from "../i18n/I18nProvider";
import { useEffect, useRef, useState } from "react";
import { MessageSquare, Search } from "lucide-react";
import { conversationTitle, isBusy, type ChatConversation } from "../../domain/conversation/ai-conversation";

interface Props {
  conversations: ChatConversation[];
  activeId: string;
  /** Open the selected conversation and retain its completed turns. */
  onSelect: (id: string) => void;
}

/** Classify sessions by local calendar day without using internal IDs as labels. */
function dateGroup(timestamp: number, t: Translator = japaneseTranslator): string {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  return timestamp >= today.getTime() ? t("今日") : timestamp >= yesterday.getTime() ? t("昨日") : t("以前");
}

/** Searchable conversation list with meaningful titles, recency, and a current marker. */
export function ChatHistory({ conversations, activeId, onSelect }: Props) {
  const { t, language } = useI18n();
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => { search.current?.focus(); }, []);
  const visible = conversations.filter((item) => (item.messages.length > 0 || item.id === activeId) && conversationTitle(item, t).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  const groups = new Map<string, ChatConversation[]>();
  for (const item of visible) {
    const group = dateGroup(item.updatedAt, t); const items = groups.get(group) ?? [];
    items.push(item); groups.set(group, items);
  }
  return <section aria-label={t("チャットの履歴")} className="flex min-h-0 flex-1 flex-col">
    <div className="px-3 py-3"><div className="flex items-center gap-2 rounded-sm border border-border bg-background px-2 focus-within:border-primary"><Search size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" /><input ref={search} type="search" aria-label={t("履歴を検索")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("チャットを検索")} className="h-8 min-w-0 flex-1 bg-transparent text-xs outline-none" /></div></div>
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      {visible.length === 0 && <p role="status" className="px-2 py-6 text-xs text-muted-foreground">{t("一致するチャットがありません。")}</p>}
      {[...groups].map(([group, items]) => <div key={group} className="mb-3"><h3 className="px-2 py-1 text-[11px] font-medium text-muted-foreground">{group}</h3>
        <ul>{items.map((item) => <li key={item.id}><button type="button" aria-current={item.id === activeId ? "true" : undefined} onClick={() => onSelect(item.id)}
          className={`flex w-full items-start gap-2 rounded-sm px-2 py-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary ${item.id === activeId ? "bg-muted" : ""}`}>
          <MessageSquare size={14} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="min-w-0 flex-1"><span className="block truncate text-xs" title={conversationTitle(item, t)}>{conversationTitle(item, t)}</span><span className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground"><time dateTime={new Date(item.updatedAt).toISOString()}>{new Intl.DateTimeFormat(intlLocale(language), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(item.updatedAt)}</time><span>{isBusy(item.messages) ? t("応答中") : item.id === activeId ? t("現在のチャット") : t("{{count}} 件の依頼", { count: (item.messages.filter((message) => message.role === "user").length) })}</span></span></span>
        </button></li>)}</ul></div>)}
    </div>
    <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">{t("履歴はアプリ終了まで保持されます。")}</p>
  </section>;
}
