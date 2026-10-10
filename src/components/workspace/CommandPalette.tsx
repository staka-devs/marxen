import { useMemo, useState } from "react";
import { fuzzyMatch } from "../../lib/workspace";

export interface PaletteCommand {
  id: string;
  label: string;
}

interface Props {
  open: boolean;
  commands: PaletteCommand[];
  onRun: (id: string) => void;
  onClose: () => void;
}

export function CommandPalette({ open, commands, onRun, onClose }: Props) {
  const [query, setQuery] = useState("");
  const hits = useMemo(() => commands.filter((command) => fuzzyMatch(query, command.label)).slice(0, 20), [commands, query]);
  if (!open) return null;
  return (
    <div data-testid="command-palette" role="dialog" aria-label="コマンドパレット" className="absolute inset-x-0 top-12 z-20 mx-auto max-w-lg rounded-lg border border-border bg-card p-3 shadow-lg">
      <input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="コマンドを入力…"
        aria-label="コマンドで絞り込む"
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
      />
      <ul className="mt-2 max-h-60 overflow-auto">
        {hits.map((command) => (
          <li key={command.id}>
            <button
              type="button"
              onClick={() => {
                onRun(command.id);
                setQuery("");
                onClose();
              }}
              className="w-full rounded px-3 py-2 text-left text-sm hover:bg-muted"
            >
              {command.label}
            </button>
          </li>
        ))}
        {hits.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">一致するコマンドがありません</li>}
      </ul>
    </div>
  );
}
