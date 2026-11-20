import type { LabelKey } from "../../contracts/localization";
import type { RuntimeStatus } from "../../contracts/contracts";
import type { OpenDoc } from "../../application/document/document-helpers";
import { COPY_LABELS } from "../../domain/clipboard-text";
import { useI18n } from "../i18n/I18nProvider";

const MODE_JA: Record<string, string> = {
  normal: "ノーマル",
  insert: "挿入",
  replace: "置換",
  visual: "選択",
  visual_line: "行選択",
  visual_block: "矩形選択",
  command_line: "コマンド",
  terminal: "ターミナル",
};

/** Values the status bar shows; all owned by the shell's hooks. */
export interface StatusBarProps {
  desktop: boolean;
  active: OpenDoc | null;
  vimMode: string;
  /** 1-based `line:column`, or null without a cursor. */
  cursorPos: string | null;
  /** True right after a yank, while a copy-format key may follow. */
  copyReady: boolean;
  copyKeys: Record<string, string>;
  vimKeys: string;
  runtime: RuntimeStatus | null;
}

/**
 * Bottom status bar: Vim mode, cursor and only the states that need attention.
 *
 * Saved/connected states and diagnostics stay in the accessibility tree
 * without taking screen space.
 */
export function StatusBar({ desktop, active, vimMode, cursorPos, copyReady, copyKeys, vimKeys, runtime }: StatusBarProps) {
  const { t } = useI18n();
  return (
    <footer className="marxen-status flex h-6 shrink-0 items-center gap-3 whitespace-nowrap border-t border-border bg-card px-3 text-[11px] text-muted-foreground">
      {desktop && active && <span data-testid="vim-footer-mode" data-mode={vimMode} className="marxen-vim-mode -ml-3 flex h-6 shrink-0 items-center px-3 font-semibold">{MODE_JA[vimMode] ? t(MODE_JA[vimMode] as LabelKey) : vimMode}</span>}
      <span className="min-w-0 flex-1" />
      {cursorPos && <span data-testid="cursor" title={t("カーソル位置")}><span className="sr-only">{t("カーソル")}{" "}</span>{cursorPos}</span>}
      <span data-testid="dirty" className={active?.dirty ? undefined : "sr-only"}>{!active ? "" : active.dirty ? t("未保存") : t("保存済み")}</span>
      {desktop && copyReady && <span data-testid="copy-ready" className="min-w-0 max-w-72 truncate" title={Object.entries(copyKeys).map(([format, key]) => `${key} ${t(COPY_LABELS[format as keyof typeof COPY_LABELS] as LabelKey)}`).join(" / ")}>{t("コピー形式を選択")}</span>}
      {!desktop && <span data-testid="readonly-note" title={t("ブラウザ表示は読み取り専用です")} className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-[10px]">{t("読み取り専用")}</span>}
      <span role="status" className={runtime?.connection === "connected" ? "sr-only" : "shrink-0"}>
        {runtime ? (runtime.connection === "disconnected" ? t("Neovim 未接続") : runtime.connection === "connected" ? t("Neovim 接続済み") : runtime.detail) : t("接続状態を確認中…")}
      </span>
      <span className="sr-only">
        <span data-testid="revision">{t("リビジョン {{value0}}", { value0: active?.revision ?? "—" })}</span>
        {desktop && vimKeys !== "" && <span data-testid="vim-keys">{t("Vim入力 {{value0}}", { value0: vimKeys })}</span>}
      </span>
    </footer>
  );
}
