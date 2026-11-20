// New-file names (domain): every new note is Markdown.

/** The path with `.md` appended unless it already ends in `.md` or `.markdown`. */
export function markdownPath(path: string): string {
  return /\.(md|markdown)$/i.test(path) ? path : `${path}.md`;
}
