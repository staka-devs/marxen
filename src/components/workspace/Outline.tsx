import { outlineFromMarkdown } from "../../lib/workspace";

interface Props {
  text: string;
  onJump: (offset: number) => void;
}

export function Outline({ text, onJump }: Props) {
  const items = outlineFromMarkdown(text);
  return (
    <section data-testid="outline" aria-label="アウトライン" className="border-t border-border p-3">
      <p className="mb-2 text-xs font-semibold tracking-wider text-muted-foreground">アウトライン</p>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">見出しがありません</p>
      ) : (
        <ul className="max-h-48 space-y-1 overflow-auto">
          {items.map((item) => (
            <li key={`${item.line}:${item.offset}`}>
              <button
                type="button"
                onClick={() => onJump(item.offset)}
                className="w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-muted"
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
