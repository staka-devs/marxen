import { Check, Sparkles, Undo2 } from "lucide-react";
import { useI18n } from "../i18n/I18nProvider";
import type { AiChange } from "../shell/hooks/useAiStaging";

interface Props {
  changes: AiChange[];
  /** Visible filename per document ID. */
  labels: Record<string, string>;
  activeId: string | null;
  /** Show one changed document in the editor. */
  onOpen: (documentId: string) => void;
  /** Accept the changes and clear the inline diff. */
  onKeep: () => void;
  /** Restore the texts from before the change. */
  onUndo: () => void;
}

/** Editor bar after an AI run rewrote files: which files changed, then keep or undo. */
export function AiChangesBar({ changes, labels, activeId, onOpen, onKeep, onUndo }: Props) {
  const { t } = useI18n();
  if (changes.length === 0) return null;
  return (
    <div role="region" aria-label={t("AI の変更")} className="marxen-ai-bar flex min-h-8 shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1 text-xs">
      <Sparkles size={14} aria-hidden="true" className="shrink-0 text-primary" />
      <span className="shrink-0 font-medium">{t("AI が変更しました")}</span>
      <span className="flex min-w-0 flex-1 flex-wrap gap-1">
        {changes.map((change) => (
          <button key={change.documentId} type="button" onClick={() => onOpen(change.documentId)} aria-current={change.documentId === activeId ? "page" : undefined}
            className="max-w-48 truncate rounded-sm px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground">
            {labels[change.documentId] ?? t("文書")}
          </button>
        ))}
      </span>
      <button type="button" onClick={onKeep} className="flex shrink-0 items-center gap-1 rounded-sm bg-primary px-2 py-1 font-medium text-primary-foreground hover:opacity-90">
        <Check size={13} aria-hidden="true" />{t("保持")}
      </button>
      <button type="button" onClick={onUndo} className="flex shrink-0 items-center gap-1 rounded-sm border border-border px-2 py-1 hover:bg-muted">
        <Undo2 size={13} aria-hidden="true" />{t("元に戻す")}
      </button>
    </div>
  );
}
