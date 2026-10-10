import { useMemo, useState } from "react";
import { fuzzyMatch } from "../../domain/workspace-content";
import { QuickPicker } from "./QuickPicker";

export interface PaletteCommand {
  id: string;
  label: string;
}
interface Props {
  open: boolean;
  commands: PaletteCommand[];
  /** Run the chosen command by ID. */
  onRun: (id: string) => void;
  /** Close without running a command. */
  onClose: () => void;
}

/** Mount a keyboard-navigable command picker for each fresh palette session. */
export function CommandPalette({ open, ...props }: Props) {
  return open ? <CommandPicker {...props} /> : null;
}

/** Filter commands with the shared picker while preserving their accessible labels. */
function CommandPicker({ commands, onRun, onClose }: Omit<Props, "open">) {
  const [query, setQuery] = useState("");
  const items = useMemo(() => commands.filter((command) => fuzzyMatch(query, command.label)).slice(0, 20), [commands, query]);
  return <QuickPicker label="コマンドパレット" inputLabel="コマンドで絞り込む" placeholder="コマンドを入力…" testId="command-palette" query={query} items={items} emptyText="一致するコマンドがありません" onQuery={setQuery} onSelect={onRun} onClose={onClose} />;
}
