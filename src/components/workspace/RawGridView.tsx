// Neovim原文ビュー: screen-dependent plugins operate here.
// Desktop attaches a headless UI and streams `redraw` grid lines; the browser
// shows the authoritative text in a grid-styled read-only pane so plugin
// screens have a defined fallback without pretending to be a terminal.

export function RawGridView({ text }: { text: string }) {
  const lines = text.split("\n").slice(0, 24);
  return (
    <section data-testid="raw-grid" aria-label="Neovim 原文ビュー" className="h-full overflow-auto rounded-lg border border-border bg-black p-4 font-mono text-xs leading-5 text-green-200">
      <p className="mb-2 text-[11px] text-green-200/70">Neovim 原文ビュー（画面依存プラグイン用・読み取り専用）</p>
      <pre className="whitespace-pre-wrap">{lines.join("\n")}</pre>
    </section>
  );
}
