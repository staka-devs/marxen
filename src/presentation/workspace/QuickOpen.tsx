import { useI18n } from "../i18n/I18nProvider";
import { useMemo, useState } from "react";
import { FileText, Image } from "lucide-react";
import { filterPaths } from "../../domain/workspace-content";
import { isImagePath } from "../../domain/workspace-files";
import { QuickPicker } from "./QuickPicker";

interface Props {
  open: boolean;
  paths: string[];
  /** Display root-qualified names while keeping selection keys independent. */
  labelFor?: (id: string) => string;
  label: string;
  testId: string;
  /** Open the selected file path. */
  onSelect: (path: string) => void;
  /** Close the dialog without opening. */
  onClose: () => void;
}

/** Mount the shared file picker only while open, resetting each search session. */
export function QuickOpen({ open, ...props }: Props) {
  return open ? <FilePicker {...props} /> : null;
}

/** Search workspace paths with filename, folder, and type icon in separate columns. */
function FilePicker({ paths, labelFor, label, testId, onSelect, onClose }: Omit<Props, "open">) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const items = useMemo(() => paths.filter((id) => filterPaths([labelFor?.(id) ?? id], query).length > 0).slice(0, 20).map((path) => {
    const normalized = (labelFor?.(path) ?? path).replaceAll("\\", "/");
    const at = normalized.lastIndexOf("/");
    const Icon = isImagePath(normalized) ? Image : FileText;
    return { id: path, accessibleLabel: normalized, label: normalized.slice(at + 1), detail: at < 0 ? "" : normalized.slice(0, at), icon: <Icon size={14} className="shrink-0 text-primary/70" aria-hidden="true" /> };
  }), [paths, query, labelFor]);
  return <QuickPicker label={label} inputLabel={t("ファイル名で絞り込む")} placeholder={t("ファイル名を入力…")} testId={testId} query={query} items={items} emptyText={t("一致するファイルがありません")} onQuery={setQuery} onSelect={onSelect} onClose={onClose} />;
}
