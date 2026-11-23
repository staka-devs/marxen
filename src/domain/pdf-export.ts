// pandoc arguments typed in settings (domain).

/**
 * Split a settings string into arguments like a POSIX shell does for quotes:
 * whitespace separates, `"..."` and `'...'` group, and `\` escapes the next
 * character outside single quotes. Nothing is expanded or executed.
 */
export function splitArguments(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let started = false;
  let quote: "\"" | "'" | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === "\"" && index + 1 < text.length) current += text[++index];
      else current += char;
    } else if (char === "\"" || char === "'") {
      quote = char;
      started = true;
    } else if (char === "\\" && index + 1 < text.length) {
      current += text[++index];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

/** Default PDF file name for a note path (untitled notes become `note.pdf`). */
export function pdfFileName(path: string | null): string {
  const parts = path?.split("/") ?? [];
  let name = (parts.at(-1) ?? "").replace(/\.(md|markdown)$/i, "");
  const folder = parts.at(-2);
  if (name === "index" && folder?.endsWith(".marxen")) name = folder.slice(0, -".marxen".length);
  return `${name || "note"}.pdf`;
}
