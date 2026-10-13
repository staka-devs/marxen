import type { LocalizedText } from "../../contracts/localization";
import { localizedFailure, renderLocalizedText } from "../../domain/localization";
import { useI18n } from "../i18n/I18nProvider";
import { useEffect, useState } from "react";
import { Maximize, ZoomIn, ZoomOut } from "lucide-react";
import type { ImageData } from "../../contracts/contracts";
import { workspaceErrorText } from "../../domain/document-errors";

/**
 * Render a workspace image with zoom controls, loading bytes via injection.
 *
 * `loadImage` comes from the composition root (Tauri loader) so this view
 * never imports infrastructure directly; failures show Japanese messages.
 */
export function ImageViewer({ path, loadImage }: {
  path: string;
  /** Load image bytes for display, injected by the composition root. */
  loadImage: (path: string) => Promise<ImageData>;
}) {
  const { t, message } = useI18n();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<LocalizedText | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null); setError(null); setZoom(null); setSize(null);
    void loadImage(path).then(data => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(new Blob([new Uint8Array(data.bytes)], { type: data.mime }));
      setUrl(objectUrl);
    }).catch(cause => { if (!cancelled) setError(localizedFailure(cause, workspaceErrorText)); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [path, loadImage]);
  /** Step the zoom level, clamped to 25–400 percent. */
  const changeZoom = (delta: number) => setZoom(value => Math.max(25, Math.min(400, (value ?? 100) + delta)));
  return <section data-testid="image-viewer" aria-label={t("{{value0}}の画像ビューアー", { value0: (path) })} className="flex min-h-0 min-w-0 flex-col overflow-hidden">
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
      <button type="button" aria-label={t("画像を縮小")} onClick={() => changeZoom(-25)} className="rounded p-1 hover:bg-muted"><ZoomOut size={15} /></button>
      <button type="button" aria-label={t("画像を拡大")} onClick={() => changeZoom(25)} className="rounded p-1 hover:bg-muted"><ZoomIn size={15} /></button>
      <button type="button" aria-label={t("画像を等倍表示")} onClick={() => setZoom(100)} className="rounded px-1 hover:bg-muted">{zoom === null ? t("フィット") : `${zoom}%`}</button>
      <button type="button" aria-label={t("画像を領域に合わせる")} onClick={() => setZoom(null)} className="rounded p-1 hover:bg-muted"><Maximize size={15} /></button>
      {size && <span className="text-muted-foreground">{size.width} × {size.height}</span>}
      <span className="ml-auto truncate text-muted-foreground">{path}</span>
    </div>
    <div className="min-h-0 flex-1 overflow-auto bg-muted/30 p-4" data-testid="image-viewport">
      {error ? <p role="alert">{renderLocalizedText(error, t)}</p> : url ? <img src={url} alt={path}
        onLoad={event => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        onError={() => setError(message("画像を表示できません。"))}
        style={zoom === null ? { maxWidth: "100%", maxHeight: "100%", objectFit: "contain", margin: "auto" }
          : { width: size ? size.width * zoom / 100 : undefined, maxWidth: "none", maxHeight: "none" }} />
        : <p role="status">{t("画像を読み込み中…")}</p>}
    </div>
  </section>;
}
