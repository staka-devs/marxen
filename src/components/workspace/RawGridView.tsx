import type { CSSProperties } from "react";
import { RotateCw } from "lucide-react";
import { gridColor, type NvimGridState } from "../../lib/grid";
import { serializeVimKey } from "../../lib/document-client";

interface Props {
  text: string;
  lines?: string[] | null;
  revision?: number;
  onRefresh?: () => void;
  grid?: NvimGridState | null;
  onVimKeys?: (keys: string) => void;
}

export function RawGridView({ text, lines, revision, onRefresh, grid, onVimKeys }: Props) {
  const rendered = lines ?? text.split("\n").slice(0, 24);
  const cursorGrid = grid?.cursor?.grid ?? 1;
  const screenId = grid?.grids[cursorGrid] ? cursorGrid : Number(Object.keys(grid?.grids ?? {})[0] ?? 1);
  const screen = grid?.grids[screenId];
  const defaultForeground = gridColor(grid?.colors.foreground) ?? "var(--foreground)";
  const defaultBackground = gridColor(grid?.colors.background) ?? "var(--background)";
  return (
    <section
      data-testid="raw-grid"
      role="textbox"
      aria-label="Neovim 画面"
      aria-multiline="true"
      aria-readonly={!onVimKeys}
      tabIndex={0}
      onClick={(event) => event.currentTarget.focus()}
      onKeyDown={(event) => {
        if (!onVimKeys || event.defaultPrevented || event.nativeEvent.isComposing || event.key === "Process" || event.keyCode === 229) return;
        const keys = serializeVimKey(event);
        if (keys === null) return;
        event.preventDefault();
        event.stopPropagation();
        onVimKeys(keys);
      }}
      onCompositionEnd={(event) => {
        if (!onVimKeys || event.data === "") return;
        event.stopPropagation();
        onVimKeys(event.data.replaceAll("<", "<lt>"));
      }}
      data-revision={revision}
      className="relative h-full min-h-0 overflow-auto p-3 font-mono text-sm leading-5 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary"
      style={{ color: defaultForeground, backgroundColor: defaultBackground }}
    >
      {onRefresh && (
        <button type="button" onClick={(event) => { event.stopPropagation(); onRefresh(); }} aria-label="Neovim 画面を更新する" title="再描画" className="absolute right-2 top-2 z-10 rounded p-1 text-muted-foreground hover:bg-muted">
          <RotateCw size={14} aria-hidden="true" />
        </button>
      )}
      {screen ? (
        <div data-testid="nvim-screen" style={{ display: "grid", gridTemplateColumns: `repeat(${screen.width}, 1ch)`, width: `${screen.width}ch` }}>
          {screen.rows.flatMap((row, rowIndex) => row.map((cell, col) => {
            if (cell.text === "" && col > 0 && row[col - 1].text !== "") return null;
            const width = row[col + 1]?.text === "" ? 2 : 1;
            const highlight = grid?.highlights[cell.highlight] ?? {};
            let foreground = gridColor(highlight.foreground) ?? defaultForeground;
            let background = gridColor(highlight.background) ?? defaultBackground;
            if (highlight.reverse) [foreground, background] = [background, foreground];
            const cursor = !grid?.busy && grid?.cursor?.grid === screenId && grid.cursor.row === rowIndex && grid.cursor.col === col;
            const style: CSSProperties = {
              gridRow: rowIndex + 1,
              gridColumn: `${col + 1} / span ${width}`,
              height: "1.4em",
              whiteSpace: "pre",
              color: cursor ? background : foreground,
              backgroundColor: cursor ? foreground : background,
              fontWeight: highlight.bold ? 700 : undefined,
              fontStyle: highlight.italic ? "italic" : undefined,
              textDecoration: [highlight.underline && "underline", highlight.strikethrough && "line-through"].filter(Boolean).join(" ") || undefined,
              textDecorationColor: gridColor(highlight.special),
            };
            return <span key={`${rowIndex}:${col}`} style={style} data-nvim-cursor={cursor || undefined}>{cell.text || " "}</span>;
          }))}
        </div>
      ) : <pre className="whitespace-pre">{rendered.join("\n")}</pre>}
    </section>
  );
}
