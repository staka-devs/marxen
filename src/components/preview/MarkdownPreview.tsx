import { useEffect, useRef, useState } from "react";
import { renderMarkdownDocument, type RenderResult } from "../../lib/render/pipeline";
import { hydrateMarkdownView } from "./hydrate";
import "leaflet/dist/leaflet.css";

interface Props {
  text: string;
  label?: string;
  testId?: string;
}

/**
 * Shared Markdown view for live and read modes (Issue #6).
 *
 * Both modes render through the same remark/rehype pipeline, so the syntax
 * tree and `data-source-*` ranges are identical. Special blocks (Mermaid /
 * GeoJSON / TopoJSON / STL) hydrate locally with bundled libraries; raw
 * source and Japanese errors stay visible for malformed input.
 */
export function MarkdownPreview({ text, label = "プレビュー", testId = "preview" }: Props) {
  const [result, setResult] = useState<RenderResult | null>(null);
  const hostRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    renderMarkdownDocument(text)
      .then((next) => {
        if (!cancelled) setResult(next);
      })
      .catch(() => {
        if (!cancelled) {
          setResult({
            html: "<div class=\"marxen-error\" role=\"alert\">描画できませんでした。原文は保持されています。</div>",
            diagnostics: [],
            blocks: [],
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [text]);

  useEffect(() => {
    if (!result || !hostRef.current) return;
    void hydrateMarkdownView(hostRef.current);
  }, [result]);

  if (!result) {
    return (
      <article
        data-testid={testId}
        aria-label={label}
        className="marxen-md h-full overflow-auto rounded-lg border border-border bg-card p-5 text-sm leading-7"
      >
        <p className="text-muted-foreground">描画を準備しています…</p>
      </article>
    );
  }

  return (
    <article
      ref={hostRef}
      data-testid={testId}
      aria-label={label}
      data-diagnostics={result.diagnostics.length}
      className="marxen-md h-full overflow-auto rounded-lg border border-border bg-card p-5 text-sm leading-7"
      // Sanitized by renderMarkdownDocument: no raw HTML or scripts pass through.
      dangerouslySetInnerHTML={{ __html: result.html }}
    />
  );
}
