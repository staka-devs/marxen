// Neovim原文ビュー: screen-dependent plugins operate here.
//
// Desktop renders the actual Neovim grid (`fetch_grid` redraw updates parsed
// with `gridLinesFromRedraw`); the browser shows the authoritative text in a
// grid-styled read-only pane so plugin screens have a defined fallback
// without pretending to be a terminal.

interface Props {
  text: string;
  lines?: string[] | null;
  revision?: number;
  onRefresh?: () => void;
}

export function RawGridView({ text, lines, revision, onRefresh }: Props) {
  const rendered = lines ?? text.split("\n").slice(0, 24);
  return (
    <section data-testid="raw-grid" aria-label="Neovim 原文ビュー" className="h-full overflow-auto rounded-lg border border-border bg-black p-4 font-mono text-xs leading-5 text-green-200">
      <div className="mb-2 flex items-center gap-2">
        <p className="text-[11px] text-green-200/70">Neovim 原文ビュー（画面依存プラグイン用・読み取り専用{typeof revision === "number" ? `・リビジョン ${revision}` : ""}）</p>
        {onRefresh && (
          <button type="button" onClick={onRefresh} aria-label="原文ビューを更新する" className="rounded border border-green-200/30 px-2 py-0.5 text-[11px] text-green-200">
            更新
          </button>
        )}
      </div>
      <pre className="whitespace-pre-wrap">{rendered.join("\n")}</pre>
    </section>
  );
}
