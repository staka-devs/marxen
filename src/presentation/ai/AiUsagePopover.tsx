import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BarChart3, Bot, RefreshCw, X } from "lucide-react";
import type { AiUsageGateway, CodexAccountUsageGateway, TranscriptUsageGateway } from "../../application/ai/usage-ports";
import type { CodexAccountUsage, ReportedUsage, TranscriptAgent, TranscriptAgentUsage, TranscriptSession, TranscriptTokens, TranscriptUnavailableReason, UsageWindow } from "../../contracts/ai-contracts";
import type { MessageKey } from "../../contracts/localization";
import { contextOccupancy, type AgentUsage } from "../../domain/ai-usage";
import { intlLocale } from "../../domain/language";
import type { ThemeId } from "../../domain/workspace-content";
import { useI18n } from "../i18n/I18nProvider";
import { useAiUsage } from "./useAiUsage";
import { useCodexAccountUsage } from "./useCodexAccountUsage";
import { useTranscriptUsage } from "./useTranscriptUsage";

const TOKEN_FIELDS = [
  ["inputTokens", "入力トークン"], ["outputTokens", "出力トークン"], ["totalTokens", "合計トークン"],
  ["cachedReadTokens", "キャッシュ読み取り"], ["cachedWriteTokens", "キャッシュ書き込み"], ["reasoningTokens", "推論トークン"],
] as const satisfies readonly (readonly [keyof ReportedUsage, MessageKey])[];

/** Format only the period reported by the provider; never assume a fixed quota window. */
function quotaDuration(window: UsageWindow, language: string): string | undefined {
  const minutes = window.windowDurationMins;
  if (minutes === undefined) return undefined;
  const unit = minutes > 0 && minutes % 1440 === 0 ? "day" : minutes > 0 && minutes % 60 === 0 ? "hour" : "minute";
  const amount = unit === "day" ? minutes / 1440 : unit === "hour" ? minutes / 60 : minutes;
  return new Intl.NumberFormat(language, { style: "unit", unit, unitDisplay: "narrow" }).format(amount);
}

/** Render each independently reported Codex quota bucket with its actual reset time. */
function CodexQuota({ usage, detailed }: { usage: CodexAccountUsage; detailed: boolean }) {
  const { t, language } = useI18n();
  const locale = intlLocale(language);
  const percent = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  return <section aria-label={t("アカウントの利用枠")} className="border-b border-border px-3 py-3">
    <h3 className="flex items-center gap-2 text-[13px] font-medium"><Bot size={16} className="text-muted-foreground" aria-hidden="true" />Codex <span className="ml-auto text-[10px] font-normal text-muted-foreground">{t("アカウントの利用枠")}</span></h3>
    {usage.buckets.length === 0 && <p className="mt-2 text-xs text-muted-foreground">{t("利用枠は報告されていません。")}</p>}
    {usage.buckets.map((bucket) => <div key={bucket.id} className="mt-2">
      {(usage.buckets.length > 1 || bucket.name) && <p className="mb-1 truncate text-xs text-muted-foreground">{bucket.name ?? bucket.id}</p>}
      {[bucket.primary, bucket.secondary].flatMap((window, index) => window ? [<div key={index} className="mt-2">
        <div className="flex items-center gap-2 text-[11px]">
          <span className="w-9 shrink-0 text-muted-foreground">{quotaDuration(window, locale) ?? t("利用枠")}</span>
          <div role="progressbar" aria-label={t("利用枠の使用率")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.usedPercent} aria-valuetext={`${percent.format(window.usedPercent)}% ${t("使用済み")}`} className="h-1.5 min-w-6 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary/70" style={{ width: `${window.usedPercent}%` }} /></div>
          <span className="shrink-0 font-medium tabular-nums">{percent.format(window.usedPercent)}%</span><span className="text-muted-foreground">{t("使用済み")}</span>
        </div>
        {detailed && window.resetsAt !== undefined && <p className="mt-1 pl-11 text-[10px] text-muted-foreground">{t("リセット")} {new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(window.resetsAt * 1000)}</p>}
      </div>] : [])}
      {detailed && bucket.credits && <p className="mt-2 text-xs text-muted-foreground">{t("クレジット残高")} <span className="ml-2 text-foreground tabular-nums">{bucket.credits.unlimited ? t("無制限") : bucket.credits.balance ?? (bucket.credits.hasCredits ? t("未報告") : t("利用できるクレジットなし"))}</span></p>}
    </div>)}
    {detailed && <p className="mt-2 text-[10px] text-muted-foreground">{t("最終更新")} {new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(usage.receivedMs)}</p>}
  </section>;
}

/** Agents without an official way to read account quota; listed as unavailable, never estimated. */
const QUOTA_UNAVAILABLE = ["Claude Code", "OpenCode", "GitHub Copilot"] as const;

/** List quota rows that cannot be read so their absence is explicit rather than silent. */
function UnavailableQuotas({ detailed }: { detailed: boolean }) {
  const { t } = useI18n();
  return <section aria-label={t("その他の利用枠")} className="border-b border-border px-3 py-2">
    {QUOTA_UNAVAILABLE.map((name) => <p key={name} className="flex items-center gap-2 py-0.5 text-xs">
      <Bot size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="shrink-0 text-muted-foreground">{t("利用枠: 取得不可")}</span>
    </p>)}
    {detailed && <p className="mt-1 text-[10px] text-muted-foreground">{t("公式の取得手段がないため表示しません。推計もしません。")}</p>}
  </section>;
}

/** Position the popup within the viewport while keeping the chat header visible. */
function popupPosition(anchor: HTMLElement) {
  const bounds = anchor.getBoundingClientRect();
  const width = Math.min(416, window.innerWidth - 24);
  const top = Math.max(12, Math.min(bounds.bottom + 6, window.innerHeight - 180));
  return { top, left: Math.max(12, Math.min(bounds.right - width, window.innerWidth - width - 12)), width, maxHeight: Math.max(120, window.innerHeight - top - 12) };
}

/** Show actual context, token, and cost observations without estimating account quota. */
function UsageRow({ agent, detailed }: { agent: AgentUsage; detailed: boolean }) {
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(intlLocale(language));
  const percent = contextOccupancy(agent.context);
  const percentage = percent === undefined ? undefined : new Intl.NumberFormat(intlLocale(language), { maximumFractionDigits: 1 }).format(percent);
  const name = agent.provider === "acp" ? ({ codex: "Codex", opencode: "OpenCode", copilot: "GitHub Copilot", claude_code: "Claude Code", devin: "Devin", custom: t("カスタムエージェント") })[agent.preset ?? "custom"] : agent.provider === "anthropic" ? "Anthropic API" : agent.provider === "openai_responses" ? "OpenAI Responses" : t("OpenAI Chat Completions");
  const tokens = TOKEN_FIELDS.flatMap(([key, label]) => {
    const value = agent.tokens?.[key];
    return typeof value === "number" ? [{ key, label, value }] : [];
  });
  return <article className="border-b border-border px-3 py-3 last:border-b-0">
    <div className="flex min-w-0 items-center gap-2">
      <Bot size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />
      <h3 className="min-w-0 flex-1 truncate text-[13px] font-medium">{name}</h3>
      {!detailed && agent.cost && <span className="shrink-0 text-xs tabular-nums" title={t("セッション料金")}>{agent.cost.amount} {agent.cost.currency}</span>}
    </div>
    {agent.context && <div className="mt-2 flex min-w-0 items-center gap-2 text-[11px]">
      <span className="shrink-0 text-muted-foreground">{t("コンテキスト")}</span>
      {percent !== undefined && <>
        <div role="progressbar" aria-label={t("コンテキスト使用率")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.max(0, percent))} aria-valuetext={`${number.format(agent.context.used)} / ${number.format(agent.context.size)}`} className="h-1.5 min-w-6 flex-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
        </div>
        <span className="shrink-0 font-medium tabular-nums">{percentage}%</span>
      </>}
      <span className="shrink-0 text-muted-foreground tabular-nums">{number.format(agent.context.used)} / {number.format(agent.context.size)}</span>
    </div>}
    {!agent.context && tokens.length === 0 && !agent.cost && <p className="mt-2 text-xs text-muted-foreground">{t("未報告")}</p>}
    {!detailed && !agent.context && agent.tokens?.totalTokens !== undefined && <p className="mt-2 text-xs text-muted-foreground">{t("合計トークン")} <span className="text-foreground tabular-nums">{number.format(agent.tokens.totalTokens)}</span></p>}
    {detailed && <>
      <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-xs">
        {agent.cost && <><dt className="text-muted-foreground">{t("セッション料金")}</dt><dd className="text-right tabular-nums">{agent.cost.amount} {agent.cost.currency}</dd></>}
        {tokens.map(({ key, label, value }) => <div key={key} className="contents"><dt className="text-muted-foreground">{t(label)}</dt><dd className="text-right tabular-nums">{number.format(value)}</dd></div>)}
      </dl>
      {tokens.length > 0 && <p className="mt-2 text-[11px] leading-4 text-muted-foreground">{t("トークン集計範囲: 不明")}</p>}
      <p className="mt-2 text-[10px] text-muted-foreground">{t("最終更新")} {new Intl.DateTimeFormat(intlLocale(language), { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(agent.receivedMs)}</p>
    </>}
  </article>;
}

/** Display names for locally scanned transcript agents. */
const TRANSCRIPT_NAMES: Record<TranscriptAgent, string> = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
  copilot: "GitHub Copilot",
};

/** Transcript token counters in display order, excluding wire-only totals. */
const TRANSCRIPT_TOKEN_FIELDS = [
  ["inputTokens", "入力トークン"], ["outputTokens", "出力トークン"],
  ["cachedReadTokens", "キャッシュ読み取り"], ["cachedWriteTokens", "キャッシュ書き込み"], ["reasoningTokens", "推論トークン"],
] as const satisfies readonly (readonly [keyof TranscriptTokens, MessageKey])[];

/** Localized explanation for an empty transcript agent without inventing totals. */
function transcriptReasonLabel(reason: TranscriptUnavailableReason, t: (key: MessageKey) => string): string {
  switch (reason) {
    case "store_missing": return t("記録がありません。");
    case "no_token_data": return t("アプリ内で使った記録はありません。");
    case "scan_failed": return t("記録を読み取れませんでした。");
  }
}

/** Sum reported session counters, keeping a field absent when no session reported it. */
function sumTranscriptTokens(sessions: TranscriptSession[]): TranscriptTokens {
/** Add one optional session counter, keeping the sum absent when nothing reported it. */
  const add = (base: number | undefined, extra: number | undefined): number | undefined =>
    extra === undefined ? base : (base ?? 0) + extra;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cachedReadTokens: number | undefined;
  let cachedWriteTokens: number | undefined;
  let reasoningTokens: number | undefined;
  for (const session of sessions) {
    inputTokens = add(inputTokens, session.tokens.inputTokens);
    outputTokens = add(outputTokens, session.tokens.outputTokens);
    cachedReadTokens = add(cachedReadTokens, session.tokens.cachedReadTokens);
    cachedWriteTokens = add(cachedWriteTokens, session.tokens.cachedWriteTokens);
    reasoningTokens = add(reasoningTokens, session.tokens.reasoningTokens);
  }
  return { inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, reasoningTokens };
}

/** Show one transcript agent's measured totals without estimating quota or cost. */
function TranscriptAgentRow({ agent, detailed }: { agent: TranscriptAgentUsage; detailed: boolean }) {
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(intlLocale(language));
  const totals = sumTranscriptTokens(agent.sessions);
  const entries = TRANSCRIPT_TOKEN_FIELDS.flatMap(([key, label]) => {
    const value = totals[key];
    return typeof value === "number" ? [{ key, label, value }] : [];
  });
  return <article className="border-b border-border px-3 py-3 last:border-b-0">
    <div className="flex min-w-0 items-center gap-2">
      <Bot size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />
      <h3 className="min-w-0 flex-1 truncate text-[13px] font-medium">{TRANSCRIPT_NAMES[agent.agent]}</h3>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{t("セッション数")}: {number.format(agent.sessions.length)}</span>
    </div>
    {agent.sessions.length === 0 && agent.reason && <p className="mt-2 text-xs text-muted-foreground">{transcriptReasonLabel(agent.reason, t)}</p>}
    {agent.sessions.length === 0 && !agent.reason && <p className="mt-2 text-xs text-muted-foreground">{t("未報告")}</p>}
    {!detailed && entries.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{entries.map(({ label, value }) => `${t(label)} ${number.format(value)}`).join(" · ")}</p>}
    {detailed && entries.length > 0 && <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-xs">
      {entries.map(({ key, label, value }) => <div key={key} className="contents"><dt className="text-muted-foreground">{t(label)}</dt><dd className="text-right tabular-nums">{number.format(value)}</dd></div>)}
    </dl>}
    {detailed && agent.sessions.map((session) => {
      const sessionEntries = TRANSCRIPT_TOKEN_FIELDS.flatMap(([key, label]) => {
        const value = session.tokens[key];
        return typeof value === "number" ? [{ key, label, value }] : [];
      });
      const updated = session.updatedMs === undefined ? undefined : new Intl.DateTimeFormat(intlLocale(language), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(session.updatedMs);
      return <div key={session.sessionId} className="mt-2 border-t border-border pt-2 text-xs">
        <p className="truncate text-muted-foreground" title={session.sessionId}>{session.title ?? session.model ?? session.sessionId}</p>
        <p className="mt-1 text-muted-foreground">{sessionEntries.map(({ label, value }) => `${t(label)} ${number.format(value)}`).join(" · ")}</p>
        {updated && <p className="mt-1 text-[10px] text-muted-foreground">{t("最終更新")} {updated}</p>}
      </div>;
    })}
  </article>;
}

interface UsagePopupProps {
  gateway: AiUsageGateway;
  accountGateway?: CodexAccountUsageGateway;
  transcriptGateway?: TranscriptUsageGateway;
  anchor: HTMLElement;
  id: string;
  theme?: ThemeId;
  /** Dismiss the read-only popup. */
  onClose: () => void;
}

/** Read-only usage popup with explicit listener cleanup and keyboard dismissal. */
function UsagePopup({ gateway, accountGateway, transcriptGateway, anchor, id, theme, onClose }: UsagePopupProps) {
  const { t } = useI18n();
  const { agents, loading, failed, refresh } = useAiUsage(gateway);
  const account = useCodexAccountUsage(accountGateway);
  const transcript = useTranscriptUsage(transcriptGateway);
  const refreshing = loading || account.loading || transcript.loading;
  const [detailed, setDetailed] = useState(true);
  const [position, setPosition] = useState(() => popupPosition(anchor));
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { panel.current?.focus(); }, []);
  useEffect(() => {
    /** Dismiss outside the popup without stealing the newly selected control's focus. */
    function dismissOutside(event: Event) {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !anchor.contains(event.target)) onClose();
    }
    /** Close on Escape and restore the chat-header control. */
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); onClose(); anchor.focus();
    }
    /** Reposition when the visible viewport changes. */
    function reposition() { setPosition(popupPosition(anchor)); }
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", reposition);
    };
  }, [anchor, onClose]);
  return createPortal(<div ref={panel} id={id} data-theme={theme} role="dialog" aria-label={t("使用量")} tabIndex={-1} style={position} className="fixed z-50 flex flex-col overflow-hidden rounded-md border border-border bg-card text-foreground shadow-xl outline-none">
    <div className="flex shrink-0 items-center gap-1 px-3 py-2">
      <h2 className="flex-1 text-[13px] font-semibold">{t("使用量")}</h2>
      <button type="button" aria-label={t("使用量を更新")} disabled={refreshing} className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-50" onClick={() => { void refresh(); void account.refresh(); void transcript.refresh(); }}><RefreshCw size={14} className={refreshing ? "animate-spin" : ""} aria-hidden="true" /></button>
      <button type="button" aria-label={t("使用量を閉じる")} className="rounded p-1 text-muted-foreground hover:bg-muted" onClick={() => { onClose(); anchor.focus(); }}><X size={14} aria-hidden="true" /></button>
    </div>
    <div className="mx-3 mb-2 flex shrink-0 rounded border border-border p-0.5">
      {([true, false] as const).map((value) => <button key={String(value)} type="button" aria-pressed={detailed === value} className={`flex-1 rounded-sm px-2 py-1 text-xs ${detailed === value ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`} onClick={() => setDetailed(value)}>{value ? t("詳細") : t("コンパクト")}</button>)}
    </div>
    <div className="min-h-0 overflow-y-auto">
      {account.loading && !account.usage && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{t("Codex の利用枠を読み込み中…")}</p>}
      {account.failed && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{t("Codex の利用枠を取得できませんでした。")}</p>}
      {account.usage && <CodexQuota usage={account.usage} detailed={detailed} />}
      <UnavailableQuotas detailed={detailed} />
      {transcriptGateway && <section aria-label={t("アプリ内の利用")}>
        {transcript.loading && !transcript.report && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{t("使用量を読み込み中…")}</p>}
        {transcript.failed && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{t("記録を読み取れませんでした。")}</p>}
        {transcript.report && transcript.report.agents.length > 0 && <h3 className="border-b border-border px-3 py-1.5 text-[10px] text-muted-foreground">{t("アプリ内の利用")}</h3>}
        {transcript.report?.agents.map((agent) => <TranscriptAgentRow key={agent.agent} agent={agent} detailed={detailed} />)}
      </section>}
      {failed && <p role="alert" className="px-3 py-2 text-xs text-destructive">{t("使用量を読み込めませんでした。")}</p>}
      {loading && agents.length === 0 && <p role="status" className="px-3 py-4 text-xs text-muted-foreground">{t("使用量を読み込み中…")}</p>}
      {!loading && !failed && agents.length === 0 && <p className="px-3 py-3 text-xs text-muted-foreground">{t("使用量の報告がありません。")}</p>}
      {agents.length > 0 && <h3 className="border-b border-border px-3 py-1.5 text-[10px] text-muted-foreground">{t("セッションの報告")}</h3>}
      {agents.map((agent) => <UsageRow key={agent.key} agent={agent} detailed={detailed} />)}
    </div>
  </div>, document.body);
}

/** Open reported agent usage from the chat header without sending a prompt. */
export function AiUsagePopover({ gateway, accountGateway, transcriptGateway, theme }: { gateway: AiUsageGateway; accountGateway?: CodexAccountUsageGateway; transcriptGateway?: TranscriptUsageGateway; theme?: ThemeId }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const id = useId();
  return <>
    <button ref={anchor} type="button" aria-label={t("使用量")} title={t("使用量")} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} className="shrink-0 rounded-sm p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setOpen((value) => !value)}><BarChart3 size={15} aria-hidden="true" /></button>
    {open && anchor.current && <UsagePopup gateway={gateway} accountGateway={accountGateway} transcriptGateway={transcriptGateway} anchor={anchor.current} id={id} theme={theme} onClose={() => setOpen(false)} />}
  </>;
}
