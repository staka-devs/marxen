import { useI18n } from "../i18n/I18nProvider";
import { outlineFromMarkdown } from "../../domain/workspace-content";

interface Props {
  text: string;
  /** Jump the editor to a heading offset. */
  onJump: (offset: number) => void;
}

/** Markdown outline skipping fenced code, jumping by offset. */ export function Outline({ text, onJump }: Props) {
  const { t } = useI18n();
  const items = outlineFromMarkdown(text);
  return (
    <section data-testid="outline" aria-label={t("アウトライン")}>
      <p className="flex h-9 items-center px-3 text-[11px] font-medium text-muted-foreground">{t("アウトライン")}</p>
      {items.length === 0 ? (
        <p className="px-3 text-xs text-muted-foreground">{t("見出しがありません")}</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={`${item.line}:${item.offset}`}>
              <button
                type="button"
                onClick={() => onJump(item.offset)}
                className="h-6 w-full truncate px-2 text-left text-[13px] hover:bg-muted"
                style={{ paddingLeft: `${8 + (item.level - 1) * 12}px` }}
              >
                {item.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}


