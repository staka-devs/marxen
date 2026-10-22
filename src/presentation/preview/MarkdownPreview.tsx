import { useI18n } from "../i18n/I18nProvider";
import { useEffect, useRef, useState } from "react";
import { renderMarkdownDocument, type RenderResult } from "../../domain/render/pipeline";
import { disposeMarkdownView, hydrateMarkdownView } from "./hydrate";
import { hydrateLocalImages } from "../images/hydrate-images";
import type { ImageResolver } from "../../domain/image-sources";
import "leaflet/dist/leaflet.css";

interface Props {
  text: string;
  label?: string;
  testId?: string;
  /**
   * Local-image resolver (ADR-0063): the UI layer supplies a Rust-backed
   * loader mapping relative sources to displayable URLs. Invoked after the
   * sanitized HTML mounts; abort-aware and stale-safe. Absent = images stay
   * as authored (browser demo behavior).
   */
  resolveImage?: ImageResolver;
}

/**
 * Shared Markdown view for live and read modes (Issue #6).
 *
 * Both modes render through the same remark/rehype pipeline, so the syntax
 * tree and `data-source-*` ranges are identical. Special blocks (Mermaid /
 * GeoJSON / TopoJSON / STL) hydrate locally with bundled libraries; raw
 * source and Japanese errors stay visible for malformed input.
 */
export function MarkdownPreview({ text, label, testId = "preview", resolveImage }: Props) {
  const { t, language } = useI18n();
  const [result, setResult] = useState<RenderResult | null>(null);
  const hostRef = useRef<HTMLElement | null>(null);
  const latestPipeline = useRef<Promise<RenderResult> | null>(null);

  useEffect(() => {
    let cancelled = false;
    // The previous HTML stays until the new render lands (no flash, scroll kept).
    // Superseded renders are discarded: only the latest text wins, so a
    // slow pass can never overwrite newer HTML (stale-result guard).
    const pipeline = renderMarkdownDocument(text, t);
    pipeline
      .then((next) => {
        if (!cancelled && pipeline === latestPipeline.current) setResult(next);
      })
      .catch(() => {
        if (!cancelled && pipeline === latestPipeline.current) {
          setResult({
            html: t("<div class=\"marxen-error\" role=\"alert\">描画できませんでした。Markdownは保持されています。</div>"),
            diagnostics: [],
            blocks: [],
          });
        }
      });
    latestPipeline.current = pipeline;
    return () => {
      cancelled = true;
    };
  }, [text, t, language]);

  useEffect(() => {
    if (!result || !hostRef.current) return;
    const host = hostRef.current;
    // A new result aborts the previous hydrate pass and disposes its maps
    // and GL resources before fresh placeholders are enhanced. Local images
    // resolve on the same lifecycle so late bytes never land on stale HTML.
    const controller = new AbortController();
    const pending: Array<Promise<unknown>> = [hydrateMarkdownView(host, controller.signal, t)];
    if (resolveImage) pending.push(hydrateLocalImages(host, resolveImage, controller.signal));
    void Promise.allSettled(pending);
    return () => {
      controller.abort();
      disposeMarkdownView(host);
    };
  }, [result, resolveImage, t]);

  if (!result) {
    return (
      <article
        data-testid={testId}
        aria-label={label ?? t("プレビュー")}
        className="marxen-md h-full overflow-auto bg-background px-6 py-4 text-sm leading-7"
      >
        <p className="text-muted-foreground">{t("描画を準備しています…")}</p>
      </article>
    );
  }

  return (
    <article
      ref={hostRef}
      data-testid={testId}
      aria-label={label ?? t("プレビュー")}
      data-diagnostics={result.diagnostics.length}
      className="marxen-md h-full overflow-auto bg-background px-6 py-4 text-sm leading-7"
      // Sanitized by renderMarkdownDocument: no raw HTML or scripts pass through.
      dangerouslySetInnerHTML={{ __html: result.html }}
    />
  );
}
