import { Button } from "../ui/button";
import type { FormatKind } from "../../lib/markdown-gui";

interface Props {
  onFormat: (kind: FormatKind) => void;
  onCheckbox: () => void;
  onTable: () => void;
  onTableRow: () => void;
  onTableColumn: () => void;
  onLink: () => void;
  onImage: () => void;
  onUndo: () => void;
  canUndo: boolean;
  vimMode: string;
  disabled?: boolean;
}

const formats: { kind: FormatKind; label: string }[] = [
  { kind: "bold", label: "太字" },
  { kind: "italic", label: "斜体" },
  { kind: "strike", label: "取消線" },
  { kind: "code", label: "コード" },
];

export function GuiToolbar(props: Props) {
  const disabled = props.disabled ?? false;
  return (
    <div data-testid="gui-toolbar" aria-label="GUI 編集ツールバー" className="flex flex-wrap items-center gap-2">
      {formats.map((item) => (
        <Button key={item.kind} variant="outline" size="sm" disabled={disabled} onClick={() => props.onFormat(item.kind)} aria-label={`${item.label}にする`}>
          {item.label}
        </Button>
      ))}
      <Button variant="outline" size="sm" disabled={disabled} onClick={props.onCheckbox} aria-label="チェックリストを切り替える">チェック</Button>
      <Button variant="outline" size="sm" disabled={disabled} onClick={props.onTable} aria-label="表を挿入する">表</Button>
      <Button variant="outline" size="sm" disabled={disabled} onClick={props.onTableRow} aria-label="表に行を追加する">行追加</Button>
      <Button variant="outline" size="sm" disabled={disabled} onClick={props.onTableColumn} aria-label="表に列を追加する">列追加</Button>
      <Button variant="outline" size="sm" disabled={disabled} onClick={props.onLink} aria-label="リンクを挿入する">リンク</Button>
      <Button variant="outline" size="sm" disabled={disabled} onClick={props.onImage} aria-label="画像を挿入する">画像</Button>
      <Button variant="outline" size="sm" onClick={props.onUndo} disabled={disabled || !props.canUndo} aria-label="元に戻す">
        元に戻す
      </Button>
      <span data-testid="vim-mode" aria-label="Vim モード" className="ml-auto rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
        {props.vimMode}
      </span>
    </div>
  );
}
