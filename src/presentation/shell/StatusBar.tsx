import { Info } from "lucide-react";
import { useI18n } from "../i18n/I18nProvider";
import { COPY_LABELS } from "../../domain/clipboard-text";
import type { LabelKey } from "../../contracts/localization";
import type { RuntimeStatus } from "../../contracts/contracts";
import type { OpenDoc } from "../../application/document/document-helpers";

/** Vim mode names shown in the mode chip. */
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

interface Props {
  desktop: boolean;
  active: OpenDoc | null;
  vimMode: string;
  /** Last segment of the workspace root. */
  rootName: string;
  cursorPos: string | null;
  /** The active document has a yank waiting for a copy-format choice. */
  copyReady: boolean;
  copyKeys: Record<string, string>;
  runtime: RuntimeStatus | null;
  vimKeys: string;
}

/** Window-wide status bar: Vim mode chip, cursor, save state and Neovim connection. */
export function StatusBar({ desktop, active, vimMode, rootName, cursorPos, copyReady, copyKeys, runtime, vimKeys }: Props) {
  const { t } = useI18n();
  return (
    <footer className="marxen-status flex h-6 shrink-0 items-center gap-3 whitespace-nowrap border-t border-border bg-card px-3 text-[11px] text-muted-foreground">
      {desktop && active && <span data-testid="vim-footer-mode" data-mode={vimMode} className="marxen-vim-mode -ml-3 flex h-6 shrink-0 items-center px-3 font-semibold">{MODE_JA[vimMode] ? t(MODE_JA[vimMode] as LabelKey) : vimMode}</span>}
      <span className="min-w-0 flex-1 truncate">{rootName}</span>
      {cursorPos && <span data-testid="cursor" title={t("カーソル位置")}><span className="sr-only">{t("カーソル")}{" "}</span>{cursorPos}</span>}
      <span data-testid="dirty">{!active || active.dirty ? (active ? t("未保存") : "—") : t("保存済み")}</span>
      {desktop && copyReady && <span data-testid="copy-ready" className="min-w-0 max-w-72 truncate" title={Object.entries(copyKeys).map(([format, key]) => `${key} ${t(COPY_LABELS[format as keyof typeof COPY_LABELS] as LabelKey)}`).join(" / ")}>{t("コピー形式を選択")}</span>}
      {!desktop && <span data-testid="readonly-note" title={t("ブラウザ表示は読み取り専用です")} className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-[10px]">{t("読み取り専用")}</span>}
      <span role="status" className="shrink-0">
        {runtime ? (runtime.connection === "disconnected" ? t("Neovim 未接続") : runtime.connection === "connected" ? t("Neovim 接続済み") : runtime.detail) : t("接続状態を確認中…")}
      </span>
      <details className="relative shrink-0">
        <summary aria-label={t("エディターの接続情報")} title={t("エディターの接続情報")} className="flex cursor-pointer list-none items-center rounded-sm p-0.5 hover:bg-muted"><Info size={13} aria-hidden="true" /></summary>
        <div className="absolute bottom-7 right-0 z-20 min-w-44 rounded border border-border bg-card p-3 shadow-lg">
          <span data-testid="revision" className="block">{t("リビジョン {{value0}}", { value0: active?.revision ?? "—" })}</span>
          {desktop && vimKeys !== "" && <span data-testid="vim-keys" className="mt-1 block">{t("Vim入力 {{value0}}", { value0: vimKeys })}</span>}
        </div>
      </details>
    </footer>
  );
}
