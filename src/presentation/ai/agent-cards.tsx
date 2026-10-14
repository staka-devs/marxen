import { useRef, useState } from "react";
import { FileText } from "lucide-react";
import { useI18n } from "../i18n/I18nProvider";
import type { Translator } from "../../contracts/localization";
import type { ChatPermission, ChatTool } from "../../domain/conversation/ai-conversation";
import type { PlanEntry } from "../../contracts/ai-contracts";
import type { IsolationDiff, StagedNewFile } from "../../contracts/isolation-contracts";

/**
 * Rewrite raw unified headers to the visible filename.
 *
 * Production diffs carry `--- live:<scope>` / `+++ staging:<scope>` headers
 * naming internal mechanics and scoped ranges. Display replaces both headers
 * with the real filename so no live/staging identifiers or opaque document
 * IDs leak; hunk lines and backend error rows without headers pass through
 * verbatim with their details preserved.
 */
export function displayUnifiedDiff(unified: string, label: string): string {
  const lines = unified.split("\n");
  if (lines.length >= 2 && lines[0].startsWith("--- ") && lines[1].startsWith("+++ ")) {
    return [`--- ${label}`, `+++ ${label}`, ...lines.slice(2)].join("\n");
  }
  return unified;
}

/**
 * Status label for one tool call without exposing internal run IDs.
 *
 * Maps wire statuses to user-facing progress text. Cancelled tools use a
 * distinct short label so assistant cancellation text stays unique.
 */
export function toolStatusLabel(status: ChatTool["status"], t: Translator): string {
  switch (status) {
    case "pending":
      return t("待機中");
    case "in_progress":
      return t("実行中…");
    case "completed":
      return t("完了");
    case "failed":
      return t("失敗");
    case "cancelled":
      return t("取消");
    default:
      return t("実行中…");
  }
}

/**
 * Visible tool progress card for one agent tool call in chat.
 *
 * Shows title, kind, status, and staging-relative locations; never shows
 * internal run or session IDs. No timeline is fabricated: only wire events
 * render here.
 */
export function ToolCard({ tool }: { tool: ChatTool }) {
  const { t } = useI18n();
  return (
    <div data-testid={`tool-card-${tool.id}`} className="ai-tool-card mt-1 rounded border border-border px-2 py-1.5 text-xs">
      <p className="flex items-center gap-1.5">
        <span aria-hidden="true">{tool.status === "completed" ? "✓" : tool.status === "failed" ? "✕" : tool.status === "cancelled" ? "■" : "… "}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{tool.title}</span>
        <span className="shrink-0 text-muted-foreground">{toolStatusLabel(tool.status, t)}</span>
      </p>
      {tool.locations && tool.locations.length > 0 && (
        <ul aria-label={t("対象ファイル")} className="mt-1 space-y-0.5 text-muted-foreground">
          {tool.locations.map((location, index) => (
            <li key={`${location.path}-${index}`} className="truncate font-mono text-[11px]">
              {location.path}
              {location.line !== undefined ? `:${location.line}` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Visible execution-plan card replacing its entries on every plan event.
 *
 * Shows each step with priority and status; the list always reflects the
 * latest complete payload from the agent.
 */
export function PlanCard({ entries }: { entries: PlanEntry[] }) {
  const { t } = useI18n();
  if (entries.length === 0) return null;
  return (
    <div data-testid="plan-card" className="ai-plan-card mt-1 rounded border border-border px-2 py-1.5 text-xs">
      <p className="font-medium text-muted-foreground">{t("作業計画")}</p>
      <ul className="mt-1 space-y-1">
        {entries.map((entry, index) => (
          <li key={`${entry.content}-${index}`} className="flex items-start gap-1.5 leading-5">
            <span aria-hidden="true">
              {entry.status === "completed" ? "✓" : entry.status === "in_progress" ? "… " : "○"}
            </span>
            <span className="min-w-0 flex-1">{entry.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Props for the interactive permission choice card. */
export interface PermissionCardProps {
  /** Surfaced request with actual options and settlement state. */
  permission: ChatPermission;
  /** Answer the pending request with the exact chosen option ID. */
  onChoose?: (optionId: string) => void | Promise<void>;
}

/**
 * Surfaced permission request with exact-ID choice buttons.
 *
 * Pending interactive requests render one button per offered option; choosing
 * replies through `onChoose` with the actual option ID and resolves the card.
 * Resolved cards name the chosen option, denied Ask turns show disabled
 * options without actionable buttons, and cancelled turns settle quietly.
 * Request IDs never appear in product text; they stay in test IDs only.
 */
export function PermissionCard({ permission, onChoose }: PermissionCardProps) {
  const { t } = useI18n();
  const busyRef = useRef(false);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const chosen = permission.options.find((option) => option.optionId === permission.resolvedOptionId);
  const actionable = permission.state === "pending" && permission.interactive;
  /**
   * Submit one choice exactly once while its reply is in flight.
   *
   * A ref guard (not state) blocks double clicks in the same tick; all
   * options disable while awaiting the reply and re-enable only when the
   * reply fails recoverably.
   */
  async function choose(optionId: string) {
    if (!actionable || busyRef.current) return;
    busyRef.current = true;
    setSubmitted(optionId);
    try {
      await onChoose?.(optionId);
    } catch {
      busyRef.current = false;
      setSubmitted(null);
    }
  }
  return (
    <div data-testid={`permission-card-${permission.requestId}`} className="ai-permission-card mt-1 rounded border border-amber-500/40 px-2 py-1.5 text-xs">
      <p className="font-medium">{permission.title}</p>
      {permission.state === "pending" && permission.interactive ? (
        <div className="mt-1 flex flex-wrap gap-1" role="group" aria-label={t("許可の選択")}>
          {permission.options.map((option) => (
            <button
              key={option.optionId}
              type="button"
              aria-label={option.name}
              title={option.name}
              disabled={submitted !== null}
              className="ai-permission-option rounded border border-border px-1.5 py-0.5 hover:bg-muted disabled:opacity-50"
              onClick={() => void choose(option.optionId)}
            >
              {option.name}
            </button>
          ))}
        </div>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-1">
          {permission.options.map((option) => (
            <li key={option.optionId} className="rounded border border-border px-1.5 py-0.5 text-muted-foreground">
              {option.name}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-muted-foreground">
        {permission.state === "cancelled"
          ? t("取り消しました。")
          : permission.state === "resolved"
            ? t("選択しました: {{value0}}", { value0: (chosen?.name ?? permission.resolvedOptionId ?? "") })
            : permission.state === "denied"
              ? t("拒否しました。")
              : t("許可を待っています…")}
      </p>
    </div>
  );
}

/**
 * Changed-file card for one reviewed scope or new agent file.
 *
 * Shows the visible filename and change state with a diff preview whose
 * headers name the real file; never shows internal copy, document, or
 * staging IDs.
 */
export function ChangedFileCard({
  label,
  state,
  unified,
}: {
  label: string;
  state: string;
  unified: string | null;
}) {
  const { t } = useI18n();
  return (
    <div data-testid={`changed-file-${label}`} className="ai-changed-file mt-1 rounded border border-border px-2 py-1.5 text-xs">
      <p className="flex items-center gap-1.5">
        <FileText size={13} aria-hidden="true" className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        <span className="shrink-0 text-muted-foreground">{state}</span>
      </p>
      {unified && (
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">{displayUnifiedDiff(unified, label)}</pre>
      )}
      {!unified && <p className="mt-1 text-muted-foreground">{t("新規ファイル")}</p>}
    </div>
  );
}

/**
 * Changed-file list combining reviewed diffs and new agent files.
 *
 * Existing scopes show their diff state; new Markdown files show as new.
 * Labels are visible filenames; no internal mechanics paragraph appears here.
 */
export function ChangedFileList({
  diffs,
  newFiles,
  documentLabels,
}: {
  diffs: IsolationDiff[];
  newFiles: StagedNewFile[];
  documentLabels?: Record<string, string>;
}) {
  const { t } = useI18n();
  /** Map a document ID to its visible label without internal IDs. */
  const labelFor = (documentId: string) => documentLabels?.[documentId] ?? t("文書");
  const changed = diffs.filter((diff) => diff.changed);
  if (changed.length === 0 && newFiles.length === 0) return null;
  return (
    <div data-testid="changed-file-list" className="mt-2 space-y-1">
      {changed.map((diff, index) => (
        <ChangedFileCard
          key={`${diff.documentId}-${index}`}
          label={labelFor(diff.documentId)}
          state={diff.drifted ? t(" (外部変更あり・要再同期)") : t("変更あり")}
          unified={diff.unified}
        />
      ))}
      {newFiles.map((file) => (
        <ChangedFileCard key={file.rel} label={file.rel} state={t("新規")} unified={null} />
      ))}
    </div>
  );
}
