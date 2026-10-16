import { useState } from "react";
import type { LabelKey } from "../../contracts/localization";
import { useI18n } from "../i18n/I18nProvider";
import { Bold, Italic, Strikethrough, Code, ListTodo, Table2, Link, Image, Undo2, Redo2, CornerDownLeft } from "lucide-react";
import type { FormatKind, TableAction, TableCellContext } from "../../domain/markdown-gui";

interface Props {
  /** Wrap or unwrap the captured selection. */
  onFormat: (kind: FormatKind) => void;
  /** Toggle the current task checkbox. */
  onCheckbox: () => void;
  /** Insert a table with body rows and columns chosen in the popover. */
  onTable: (rows: number, columns: number) => void;
  /** Apply one action to the captured source table cell. */
  onTableAction: (action: TableAction) => void;
  tableCell: TableCellContext | null;
  /** Insert a link at the captured selection. */
  onLink: () => void;
  /** Insert an image reference. */
  onImage: () => void;
  /** Undo through the authoritative native history. */
  onUndo: () => void;
  /** Redo through the authoritative native history. */
  onRedo: () => void;
  hardBreakOnEnter: boolean;
  /** Persist the Markdown Enter preference. */
  onHardBreakOnEnter: (enabled: boolean) => void;
  disabled?: boolean;
}

const formats = [
  { kind: "bold", label: "太字", icon: Bold },
  { kind: "italic", label: "斜体", icon: Italic },
  { kind: "strike", label: "取消線", icon: Strikethrough },
  { kind: "code", label: "コード", icon: Code },
] satisfies { kind: FormatKind; label: LabelKey; icon: typeof Bold }[];

const actions: Array<{ action: TableAction; label: LabelKey }> = [
  { action: "row-above", label: "上に行を追加" }, { action: "row-below", label: "下に行を追加" },
  { action: "column-left", label: "左に列を追加" }, { action: "column-right", label: "右に列を追加" },
  { action: "delete-row", label: "行を削除" }, { action: "delete-column", label: "列を削除" },
];

/** Compact persistent formatting with contextual table actions and a saved Enter toggle. */
export function GuiToolbar(props: Props) {
  const { t } = useI18n();
  const [tableOpen, setTableOpen] = useState(false);
  const [rows, setRows] = useState(2);
  const [columns, setColumns] = useState(3);
  const disabled = props.disabled ?? false;
  const cell = props.tableCell;
  const style = "flex h-7 shrink-0 items-center justify-center rounded px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40";
  return <div className="relative shrink-0 border-b border-border" data-testid="gui-toolbar">
    <div role="toolbar" aria-label={t("GUI 編集ツールバー")} className="flex flex-wrap items-center gap-0.5 px-2 py-0.5" onMouseDown={(event) => { if ((event.target as HTMLElement).closest("button")) event.preventDefault(); }}>
      {formats.map((item) => <button type="button" key={item.kind} disabled={disabled} onClick={() => props.onFormat(item.kind)} className={style} title={t(item.label)} aria-label={t("{{value0}}にする", { value0: t(item.label) })}><item.icon size={14} aria-hidden="true" /></button>)}
      <button type="button" disabled={disabled} onClick={props.onCheckbox} className={style} title={t("チェック")} aria-label={t("チェックリストを切り替える")}><ListTodo size={14} /></button>
      <button type="button" disabled={disabled} onClick={props.onLink} className={style} title={t("リンク")} aria-label={t("リンクを挿入する")}><Link size={14} /></button>
      <button type="button" disabled={disabled} onClick={props.onImage} className={style} title={t("画像")} aria-label={t("画像を挿入する")}><Image size={14} /></button>
      <button type="button" disabled={disabled} onClick={() => setTableOpen((open) => !open)} className={style} aria-label={t("表を挿入する")} aria-expanded={tableOpen} title={t("表")}><Table2 size={14} /></button>
      <span className="mx-1 h-4 border-l border-border" />
      <button type="button" disabled={disabled} onClick={() => props.onHardBreakOnEnter(!props.hardBreakOnEnter)} aria-pressed={props.hardBreakOnEnter} aria-label={t("EnterでMarkdown改行")} title={t("EnterでMarkdown改行")} className={`${style} gap-1 ${props.hardBreakOnEnter ? "bg-primary/10 text-primary" : ""}`}><CornerDownLeft size={14} /><span className="whitespace-nowrap text-[11px]">{t("Markdown改行")}</span></button>
      <span className="mx-1 h-4 border-l border-border" />
      <button type="button" disabled={disabled} onClick={props.onUndo} className={style} aria-label={t("元に戻す")} title={t("元に戻す")}><Undo2 size={14} /></button>
      <button type="button" disabled={disabled} onClick={props.onRedo} className={style} aria-label={t("やり直す")} title={t("やり直す")}><Redo2 size={14} /></button>
    </div>
    {tableOpen && <form aria-label={t("表のサイズ")} className="absolute left-2 top-full z-30 flex items-end gap-2 rounded border border-border bg-card p-3 shadow-lg" onSubmit={(event) => { event.preventDefault(); props.onTable(rows, columns); setTableOpen(false); }}>
      <label className="text-xs">{t("本文行数")}<input aria-label={t("本文行数")} className="ml-1 w-14 rounded border border-border bg-background px-1" type="number" min={1} max={20} value={rows} onChange={(event) => setRows(Number(event.target.value))} /></label>
      <label className="text-xs">{t("列数")}<input aria-label={t("列数")} className="ml-1 w-14 rounded border border-border bg-background px-1" type="number" min={1} max={10} value={columns} onChange={(event) => setColumns(Number(event.target.value))} /></label>
      <button type="submit" disabled={disabled || !Number.isInteger(rows) || rows < 1 || rows > 20 || !Number.isInteger(columns) || columns < 1 || columns > 10} className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground">{t("表を挿入する")}</button>
      <button type="button" className="text-xs" onClick={() => setTableOpen(false)}>{t("閉じる")}</button>
    </form>}
    {cell && <div role="toolbar" aria-label={t("表のセル操作")} className="flex flex-wrap items-center gap-0.5 px-2 pb-1" onMouseDown={(event) => { if ((event.target as HTMLElement).closest("button")) event.preventDefault(); }}>
      {actions.map(({ action, label }) => <button type="button" key={action} className={`${style} text-[11px]`} disabled={disabled || (action === "delete-row" && cell.lineIndex <= cell.startLine + 1)} onClick={() => props.onTableAction(action)}>{t(label)}</button>)}
      <label className="ml-2 text-[11px]">{t("列の配置")}<select aria-label={t("列の配置")} disabled={disabled} value={cell.alignment} className="ml-1 rounded bg-background px-1" onChange={(event) => props.onTableAction(`align-${event.target.value}` as TableAction)}>{(["none", "left", "center", "right"] as const).map((alignment) => <option key={alignment} value={alignment}>{t(({ none: "指定なし", left: "左揃え", center: "中央揃え", right: "右揃え" } as const)[alignment])}</option>)}</select></label>
    </div>}
  </div>;
}
