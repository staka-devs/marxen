import { useMemo } from "react";
import { renderMarkdownPreview } from "../../lib/preview";

export function MarkdownPreview({ text, label = "プレビュー", testId = "preview" }: { text: string; label?: string; testId?: string }) {
  const html = useMemo(() => renderMarkdownPreview(text), [text]);
  return (
    <article
      data-testid={testId}
      aria-label={label}
      className="prose max-w-none h-full overflow-auto rounded-lg border border-border bg-card p-5 text-sm leading-7"
      // Sanitized by renderMarkdownPreview: no raw HTML passes through.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
