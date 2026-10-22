import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, GitBranch, RefreshCw } from "lucide-react";
import { useI18n } from "../i18n/I18nProvider";
import { localizedFailure, renderLocalizedText } from "../../domain/localization";
import { workspaceErrorText } from "../../domain/document-errors";
import type { GitChange, GitStatus, RootScope, WorkspaceInfo } from "../../contracts/contracts";
import type { WorkspaceGateway } from "../../application/ports";

interface Props {
  roots: WorkspaceInfo[];
  gateway: Pick<WorkspaceGateway, "gitStatus" | "gitDiff">;
  /** Changes when documents are saved, so the list follows the working tree. */
  refreshKey: string;
  /** Open one changed file in the editor. */
  onOpen: (path: string, scope: RootScope) => void;
}

/** Status letters shown like VS Code's Source Control view. */
const STATUS_LABELS = {
  M: "変更",
  A: "追加",
  D: "削除",
  R: "名前変更",
  U: "競合",
  "?": "未追跡",
} as const;

/** Color one unified-diff line: additions, deletions and hunk headers. */
function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) return "text-muted-foreground";
  if (line.startsWith("+")) return "marxen-diff-add";
  if (line.startsWith("-")) return "marxen-diff-del";
  if (line.startsWith("@@")) return "marxen-diff-hunk";
  return "";
}

/** One changed file row that loads and shows its diff on demand. */
function ChangeRow({ change, scope, gateway, onOpen }: { change: GitChange; scope: RootScope; gateway: Props["gateway"]; onOpen: Props["onOpen"] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const parts = change.path.split("/");
  const name = parts.pop() ?? change.path;
  const label = t(STATUS_LABELS[change.status as keyof typeof STATUS_LABELS] ?? "変更");
  /** Expand the row and fetch its diff the first time. */
  const toggle = () => {
    setOpen((value) => !value);
    if (diff !== null || !gateway.gitDiff) return;
    gateway.gitDiff(scope, change.path, change.status)
      .then(setDiff)
      .catch((cause: unknown) => setError(renderLocalizedText(localizedFailure(cause, workspaceErrorText), t)));
  };
  return (
    <li>
      <div className="group flex h-6 items-center gap-1 pr-1 hover:bg-muted">
        <button type="button" aria-expanded={open} onClick={toggle} className="flex min-w-0 flex-1 items-center gap-1 text-left">
          {open ? <ChevronDown size={14} aria-hidden="true" className="shrink-0" /> : <ChevronRight size={14} aria-hidden="true" className="shrink-0" />}
          <span className="truncate">{name}</span>
          {parts.length > 0 && <span className="truncate text-[11px] text-muted-foreground">{parts.join("/")}</span>}
        </button>
        {change.status !== "D" && (
          <button type="button" aria-label={t("{{value0}} を開く", { value0: name })} title={t("ファイルを開く")} onClick={() => onOpen(change.path, scope)} className="hidden rounded-sm p-0.5 text-muted-foreground hover:text-foreground group-hover:block group-focus-within:block">
            <ExternalLink size={13} aria-hidden="true" />
          </button>
        )}
        <span title={label} aria-label={label} className={`marxen-scm-status w-3 shrink-0 text-center font-semibold`} data-status={change.status}>{change.status === "?" ? "U" : change.status}</span>
      </div>
      {open && (
        <pre aria-label={t("{{value0}} の差分", { value0: name })} className="mx-1 mb-1 max-h-80 overflow-auto rounded-sm border border-border bg-card px-2 py-1 font-mono text-[11px] leading-[1.5]">
          {error ?? (diff === null ? t("差分を読み込んでいます…") : diff === "" ? t("差分はありません。") : diff.split("\n").map((line, index) => <div key={index} className={diffLineClass(line)}>{line || " "}</div>))}
        </pre>
      )}
    </li>
  );
}

/** Source Control view: Git changes per workspace root with expandable diffs (Issue #121). */
export function SourceControlPanel({ roots, gateway, refreshKey, onOpen }: Props) {
  const { t } = useI18n();
  const [statuses, setStatuses] = useState<Record<string, GitStatus | string>>({});
  /** Reload every root's status; a failing root shows its own error. */
  const refresh = useCallback(() => {
    if (!gateway.gitStatus) return;
    for (const root of roots) {
      gateway.gitStatus(root.scope)
        .then((status) => setStatuses((previous) => ({ ...previous, [root.root]: status })))
        .catch((cause: unknown) => setStatuses((previous) => ({ ...previous, [root.root]: renderLocalizedText(localizedFailure(cause, workspaceErrorText), t) })));
    }
  }, [gateway, roots, t]);
  useEffect(refresh, [refresh, refreshKey]);
  return (
    <section aria-label={t("ソース管理")} className="flex min-h-0 flex-1 flex-col text-[13px]">
      <div className="flex h-8 shrink-0 items-center gap-1 px-3">
        <h2 className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("ソース管理")}</h2>
        <button type="button" aria-label={t("再読み込み")} title={t("再読み込み")} onClick={refresh} className="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {roots.length === 0 && <p className="px-3 text-xs text-muted-foreground">{t("フォルダーを開くと Git の変更を表示します。")}</p>}
        {roots.map((root) => {
          const status = statuses[root.root];
          const name = root.root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? root.root;
          return (
            <div key={root.root} className="mb-1">
              <p className="flex h-6 items-center gap-1.5 px-2 text-xs font-semibold" title={root.root}>
                <span className="truncate">{name}</span>
                {typeof status === "object" && status.branch && (
                  <span className="flex min-w-0 items-center gap-0.5 font-normal text-muted-foreground"><GitBranch size={12} aria-hidden="true" /><span className="truncate">{status.branch}</span></span>
                )}
                {typeof status === "object" && status.changes.length > 0 && <span className="ml-auto rounded-full bg-muted px-1.5 text-[10px] font-normal">{status.changes.length}</span>}
              </p>
              {status === undefined && <p className="px-3 text-xs text-muted-foreground">{t("読み込んでいます…")}</p>}
              {typeof status === "string" && <p role="alert" className="px-3 text-xs text-red-600">{status}</p>}
              {typeof status === "object" && !status.repository && <p className="px-3 text-xs text-muted-foreground">{t("Git リポジトリではありません。")}</p>}
              {typeof status === "object" && status.repository && status.changes.length === 0 && <p className="px-3 text-xs text-muted-foreground">{t("変更はありません。")}</p>}
              {typeof status === "object" && status.changes.length > 0 && (
                <ul aria-label={t("{{value0}} の変更", { value0: name })} className="pl-1">
                  {status.changes.map((change) => <ChangeRow key={change.path} change={change} scope={root.scope} gateway={gateway} onOpen={onOpen} />)}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
