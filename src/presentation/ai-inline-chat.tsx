import { useI18n } from "./i18n/I18nProvider";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Send, Square, X } from "lucide-react";
import { Button } from "./ui/button";
import "./ai-chat.css";
import { MarkdownPreview } from "./preview/MarkdownPreview";
import { describeAiError } from "../domain/ai-config";
import {
  claudeRefusalError,
  isClaudeBlockedProvider,
  keepStartedSession,
  normalizeAiError,
} from "../application/ai/ai-run-core";
import { useAiRun } from "./ai/use-ai-run";
import { ToolCard, PlanCard, PermissionCard } from "./ai/agent-cards";
import type { ChatPermission, ChatTool } from "../domain/conversation/ai-conversation";
import type { PlanEntry } from "../contracts/ai-contracts";
import { truncatePrompt } from "../domain/conversation/ai-conversation";
import type {
  AiError,
  AiPromptRequest,
  AiProviderConfig,
  ContextSummary,
  PromptContext,
  PromptMode,
  ProposalText,
  StagingTarget,
} from "../contracts/ai-contracts";
import type { AiGateway } from "../application/ports";

export interface InlineChatProps {
  documentId: string;
  /** Visible filename for the target document (no internal ids in product text). */
  documentLabel: string;
  target: { start: number; end: number; kind: "selection" | "paragraph"; excerpt: string };
  context: PromptContext;
  staging: StagingTarget | null;
  /** Register contexts for an isolated staging copy before sending. */
  ensureStaging: (contexts: PromptContext[]) => Promise<StagingTarget>;
  provider: AiProviderConfig;
  /** Fenced while the Agent chat owns a run on the shared staging slot. */
  disabled?: boolean;
  /** Broadcast busy ownership for the shared staging fence. */
  onBusyChange?: (busy: boolean) => void;
  /** Forward the completed proposal with its mode for review staging. */
  onProposal: (proposal: ProposalText, sent: ContextSummary[], mode: PromptMode) => void;
  /** Reveal the staged diff for review. */
  onReview: () => void;
  /** Close the composer, cancelling the owned run. */
  onClose: () => void;
  /** Caret anchor for floating placement, if available. */
  anchor?: () => { left: number; top: number; bottom: number } | null;
  /** Streaming transport injected by the composition root. */
  startPrompt?: AiGateway["startPrompt"];
  /**
   * Optional model controls injected by the composition root.
   *
   * Rendered above the inline input when provided; the composer never
   * invents model IDs or lists and leaves selection state to the owner.
   */
  modelControls?: ReactNode;
}

/**
 * Floating single-shot rewrite composer anchored at the caret.
 *
 * Fixed `rewrite` mode with empty history; staging and review flow through
 * props with fenced busy ownership against the Agent chat.
 */
export default function InlineChat({
  documentLabel,
  target,
  context,
  ensureStaging,
  provider,
  disabled,
  onBusyChange,
  onProposal,
  onReview,
  onClose,
  anchor,
  startPrompt: startPromptProp,
  modelControls,
}: InlineChatProps) {
  const { t } = useI18n();
  /** Injected streaming transport; throws visibly when not wired. */
  const startPromptFn: AiGateway["startPrompt"] = startPromptProp ?? (async () => { throw new Error("AI transport is not wired."); });
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState("");
  const [proposal, setProposal] = useState<ProposalText | null>(null);
  const [error, setError] = useState<AiError | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [tools, setTools] = useState<ChatTool[]>([]);
  const [plan, setPlan] = useState<PlanEntry[]>([]);
  const [permissions, setPermissions] = useState<ChatPermission[]>([]);
  const run = useAiRun(onBusyChange);
  const setBusy = run.setBusy;
  const onProposalRef = useRef(onProposal);
  onProposalRef.current = onProposal;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 16, top: 64 });

  useLayoutEffect(() => {
    /** Clamp the composer inside the viewport at the caret anchor. */
    const place = () => {
      const box = dialogRef.current?.getBoundingClientRect();
      const caret = anchor?.();
      if (!box || !caret) return;
      const left = Math.max(12, Math.min(caret.left, window.innerWidth - box.width - 12));
      const below = caret.bottom + 8;
      const top = Math.max(12, Math.min(below + box.height <= window.innerHeight - 12
        ? below : caret.top - box.height - 8, window.innerHeight - box.height - 12));
      setPosition((previous) => previous.left === left && previous.top === top ? previous : { left, top });
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    if (dialogRef.current) observer?.observe(dialogRef.current);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
      observer?.disconnect();
    };
  }, [anchor]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Unmount cleanup (cancel the owned run so late callbacks settle fenced)
  // lives in the shared hook: closing without an explicit cancel still
  // cancels through that path when the shell unmounts the composer.

  /** Send a rewrite with staging and fenced run ownership. */ async function handleSend() {
    const trimmed = truncatePrompt(prompt.trim());
    if (trimmed === "" || running || run.ownedBusy || disabled) return;
    const blockedCommand = isClaudeBlockedProvider(provider);
    if (blockedCommand !== null) {
      setError(claudeRefusalError(blockedCommand));
      return;
    }
    const token = run.beginRun();
    const capturedContext = { ...context, ranges: [...context.ranges] };
    const capturedProvider = provider;
    setRunning(true);
    setBusy(true);
    setOutput("");
    setProposal(null);
    setError(null);
    setCancelled(false);
    setTools([]);
    setPlan([]);
    setPermissions([]);
    let resolved: StagingTarget;
    try {
      resolved = await ensureStaging([capturedContext]);
    } catch (cause) {
      if (!run.isCurrent(token)) { setBusy(false, token); return; }
      setRunning(false);
      setBusy(false);
      setError(normalizeAiError(cause, t));
      return;
    }
    if (!run.isCurrent(token)) { setBusy(false, token); return; }
    if (run.isCancelRequested()) {
      setRunning(false);
      setBusy(false);
      setCancelled(true);
      return;
    }
    const request: AiPromptRequest = {
      provider: capturedProvider,
      mode: "rewrite",
      prompt: trimmed,
      contexts: [capturedContext],
      staging: resolved,
      sessionId: null,
      history: [],
    };
    try {
      const session = await startPromptFn(request, (event) => {
        if (!run.isCurrent(token)) return;
        if (run.isSettled(token)) return;
        if (event.type === "usage") return;
        if (run.isCancelRequested()) {
          if (event.type === "chunk" || event.type === "started") return;
          if (event.type === "tool_call") {
            setTools((prev) => {
              const next = [...prev];
              const record: ChatTool = {
                id: event.payload.toolCall.toolCallId,
                title: event.payload.toolCall.title,
                kind: event.payload.toolCall.kind,
                status: "cancelled",
                locations: event.payload.toolCall.locations?.map((location) => ({ ...location })),
              };
              const index = next.findIndex((item) => item.id === record.id);
              if (index >= 0) next[index] = { ...next[index], ...record };
              else next.push(record);
              return next;
            });
            return;
          }
          if (event.type === "tool_call_update" || event.type === "plan") return;
          if (event.type === "permission") {
            setPermissions((prev) => prev.some((item) => item.requestId === event.payload.requestId) ? prev : [...prev, {
              requestId: event.payload.requestId,
              toolCallId: event.payload.toolCallId,
              title: event.payload.title,
              options: event.payload.options.map((option) => ({ ...option })),
              resolution: "cancelled",
            }]);
            return;
          }
          run.markSettled(token);
          setCancelled(true);
          setRunning(false);
          setBusy(false);
          run.takeStop();
          return;
        }
        switch (event.type) {
          case "chunk":
            setOutput((previous) => previous + event.payload.text);
            break;
          case "tool_call":
            setTools((prev) => {
              const next = [...prev];
              const record: ChatTool = {
                id: event.payload.toolCall.toolCallId,
                title: event.payload.toolCall.title,
                kind: event.payload.toolCall.kind,
                status: event.payload.toolCall.status,
                locations: event.payload.toolCall.locations?.map((location) => ({ ...location })),
              };
              const index = next.findIndex((item) => item.id === record.id);
              if (index >= 0) next[index] = { ...next[index], ...record };
              else next.push(record);
              return next;
            });
            break;
          case "tool_call_update":
            setTools((prev) => prev.map((tool) => tool.id !== event.payload.update.toolCallId ? tool : {
              ...tool,
              title: event.payload.update.title ?? tool.title,
              kind: event.payload.update.kind ?? tool.kind,
              status: event.payload.update.status ?? tool.status,
              locations: event.payload.update.locations ? event.payload.update.locations.map((location) => ({ ...location })) : tool.locations,
            }));
            break;
          case "plan":
            setPlan(event.payload.entries.map((entry) => ({ ...entry })));
            break;
          case "permission":
            setPermissions((prev) => prev.some((item) => item.requestId === event.payload.requestId) ? prev : [...prev, {
              requestId: event.payload.requestId,
              toolCallId: event.payload.toolCallId,
              title: event.payload.title,
              options: event.payload.options.map((option) => ({ ...option })),
              resolution: "denied",
            }]);
            break;
          case "done":
            run.markSettled(token);
            setProposal(event.payload.proposal);
            onProposalRef.current(event.payload.proposal, event.payload.sent, "rewrite");
            setRunning(false);
            setBusy(false);
            run.takeStop();
            break;
          case "error":
            run.markSettled(token);
            setError(event.payload.error);
            setRunning(false);
            setBusy(false);
            run.takeStop();
            break;
          case "cancelled":
            run.markSettled(token);
            setCancelled(true);
            setRunning(false);
            setBusy(false);
            run.takeStop();
            break;
          case "started":
            break;
        }
      });
      if (!(await keepStartedSession(run, token, session.stop))) return;
    } catch (cause) {
      if (!run.isCurrent(token)) { setBusy(false, token); return; }
      run.markSettled(token);
      setRunning(false);
      setBusy(false);
      setError(normalizeAiError(cause, t));
    }
  }

  /** Cancel the owned inline run without touching the document. */ async function handleCancel() {
    await run.cancelOwned();
  }

  /** Close with Escape after requesting cancellation. */ function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      void handleCancel().finally(() => onCloseRef.current());
    }
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-label={t("インラインチャット")}
      data-testid="inline-chat"
      className="ai-chat-inline fixed z-40 max-h-[calc(100dvh-24px)] w-80 max-w-[calc(100vw-24px)] overflow-y-auto rounded-md border border-border bg-card px-2.5 py-2 shadow-lg"
      style={anchor ? position : undefined}
      onKeyDown={handleKeyDown}
    >
      <div className="ai-chat-inline-header flex items-center gap-1">
        <p className="min-w-0 flex-1 truncate text-xs font-semibold">
          {t("インラインチャット（")}{target.kind === "selection" ? t("選択") : t("段落")}）
        </p>
        <span className="shrink-0 rounded border border-border px-1 py-px text-[10px] leading-4 text-muted-foreground">{t("書き換え")}</span>
        <button
          type="button"
          aria-label={t("インラインチャットを閉じる")}
          title={t("閉じる")}
          className="shrink-0 rounded p-1 hover:bg-muted"
          onClick={() => {
            void handleCancel().finally(() => onClose());
          }}
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>
      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
        {documentLabel}
      </p>
      {target.excerpt !== "" && (
        <p className="ai-chat-inline-excerpt mt-1.5 max-h-20 overflow-y-auto whitespace-pre-wrap p-1.5 text-xs leading-5 text-muted-foreground">
          {target.excerpt}
        </p>
      )}
      <div className="ai-chat-composer-box mt-1.5 px-1.5 pb-1.5 pt-1">
        {modelControls && (
          <div className="ai-chat-model-slot mb-1 empty:hidden">{modelControls}</div>
        )}
        <textarea
          ref={inputRef}
          aria-label={t("インライン指示")}
          className="ai-chat-composer-input block max-h-32 min-h-10 w-full overflow-y-auto px-1 py-1 text-[13px] leading-6"
          rows={2}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={t("選択範囲への指示を書きます")}
        />
        <div className="mt-1 flex items-center gap-1">
          <Button size="sm" aria-label={t("インライン送信")} title={t("インライン送信")} onClick={() => void handleSend()} disabled={running || disabled || prompt.trim() === ""} className="ai-chat-action shrink-0">
            <Send size={13} aria-hidden="true" />
            {running ? t("送信中…") : t("送信")}
          </Button>
          {running && (
            <Button variant="outline" size="sm" aria-label={t("インライン取消")} title={t("インライン取消")} onClick={() => void handleCancel()} className="ai-chat-action shrink-0">
              <Square size={12} aria-hidden="true" />
              {t("取消")}</Button>
          )}
          {proposal && (
            <Button variant="outline" size="sm" aria-label={t("差分を確認")} title={t("提案を作業コピーに取り込み差分を確認します")} onClick={onReview} className="ai-chat-action shrink-0">
              {t("差分を確認")}</Button>
          )}
        </div>
      </div>
      {disabled && <p className="mt-1 text-[11px] text-muted-foreground">{t("他の応答を生成しています。")}</p>}
      <div aria-live="polite" className="ai-chat-inline-result mt-1 border-t border-border/60 pt-1.5 empty:hidden empty:border-t-0 empty:pt-0">
        {plan.length > 0 && <PlanCard entries={plan} />}
        {tools.map((tool) => (
          <ToolCard key={tool.id} tool={tool} />
        ))}
        {permissions.map((permission) => (
          <PermissionCard key={permission.requestId} permission={permission} />
        ))}
        {output && !proposal && <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-[13px] leading-6">{output}</p>}
        {cancelled && <p className="text-xs text-muted-foreground">{t("取り消しました。")}</p>}
        {error && (
          <p role="alert" className="text-xs font-medium text-red-600">{describeAiError(error, t)}</p>
        )}
        {proposal && (
          <div className="py-0.5">
            <p className="text-[11px] text-muted-foreground">{t("提案 • 差分確認のうえ取り込みます")}</p>
            <div className="marxen-chat-body mt-1 max-h-48 overflow-y-auto"><MarkdownPreview text={proposal.text} label={t("インラインの提案")} testId="inline-response" /></div>
          </div>
        )}
      </div>
    </div>
  );
}

