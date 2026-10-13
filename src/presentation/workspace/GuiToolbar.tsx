import type { LabelKey } from "../../contracts/localization";
import { useI18n } from "../i18n/I18nProvider";
import { Button } from "../ui/button";
import { Bold, Italic, Strikethrough, Code, ListTodo, Table2, Rows3, Columns3, Link, Image, Undo2, Redo2 } from "lucide-react";
import type { FormatKind } from "../../domain/markdown-gui";

interface Props {
  /** Wrap or unwrap the selection with a format marker. */
  onFormat: (kind: FormatKind) => void;
  /** Toggle the checkbox on the current line. */
  onCheckbox: () => void;
  /** Insert a 2x2 table at the caret. */
  onTable: () => void;
  /** Insert an empty row into the current table. */
  onTableRow: () => void;
  /** Append an empty column to the current table. */
  onTableColumn: () => void;
  /** Wrap the selection as a link. */
  onLink: () => void;
  /** Insert an image reference at the caret. */
  onImage: () => void;
  /** Undo through the native stack. */
  onUndo: () => void;
  /** Redo through the native stack. */
  onRedo: () => void;
  vimMode: string;
  disabled?: boolean;
}

const formats = [
  { kind: "bold", label: "太字", icon: Bold },
  { kind: "italic", label: "斜体", icon: Italic },
  { kind: "strike", label: "取消線", icon: Strikethrough },
  { kind: "code", label: "コード", icon: Code },
 ] satisfies { kind: FormatKind; label: string; icon: typeof Bold }[];

/** Markdown formatting toolbar emitting range edits via callbacks. */ export function GuiToolbar(props: Props) {
  const { t } = useI18n();
  const disabled = props.disabled ?? false;
  return (
    <div data-testid="gui-toolbar" aria-label={t("GUI 編集ツールバー")} role="toolbar" className="grid grid-cols-6 gap-0.5 px-1 py-1 [&_button]:h-8 [&_button]:w-full [&_button]:border-0 [&_button]:px-0 [&_button]:shadow-none">
      {formats.map((item) => (
        <Button key={item.kind} variant="outline" size="sm" disabled={disabled} onClick={() => props.onFormat(item.kind)} aria-label={t("{{value0}}にする", { value0: (t(item.label as LabelKey)) })} title={t(item.label as LabelKey)}>
          <item.icon size={15} aria-hidden="true" />
        </Button>
      ))}
      <Button variant="outline" size="sm" disabled={disabled} onClick={props.onCheckbox} aria-label={t("チェックリストを切り替える")} title={t("チェック")}><ListTodo size={15} aria-hidden="true" /></Button>
      <Button variant="outline" size="sm" disabled={disabled} onClick={props.onTable} aria-label={t("表を挿入する")} title={t("表")}><Table2 size={15} aria-hidden="true" /></Button>
      <Button variant="outline" size="sm" disabled={disabled} onClick={props.onTableRow} aria-label={t("表に行を追加する")} title={t("行追加")}><Rows3 size={15} aria-hidden="true" /></Button>
      <Button variant="outline" size="sm" disabled={disabled} onClick={props.onTableColumn} aria-label={t("表に列を追加する")} title={t("列追加")}><Columns3 size={15} aria-hidden="true" /></Button>
      <Button variant="outline" size="sm" disabled={disabled} onClick={props.onLink} aria-label={t("リンクを挿入する")} title={t("リンク")}><Link size={15} aria-hidden="true" /></Button>
      <Button variant="outline" size="sm" disabled={disabled} onClick={props.onImage} aria-label={t("画像を挿入する")} title={t("画像")}><Image size={15} aria-hidden="true" /></Button>
      <Button variant="outline" size="sm" onClick={props.onUndo} disabled={disabled} aria-label={t("元に戻す")} title={t("元に戻す")}>
        <Undo2 size={15} aria-hidden="true" />
      </Button>
      <Button variant="outline" size="sm" onClick={props.onRedo} disabled={disabled} aria-label={t("やり直す")} title={t("やり直す")}>
        <Redo2 size={15} aria-hidden="true" />
      </Button>

    </div>
  );
}

