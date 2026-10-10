import type { WorkspaceEntry, WorkspaceFileKind } from "../contracts/contracts";

export const WORKSPACE_IMAGE_DRAG = "application/x-marxen-workspace-image";
export const WORKSPACE_IMAGE_POINTER_DROP = "marxen:workspace-image-drop";
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/**
 * Check whether a path is a supported image by extension.
 *
 * Matches PNG/JPEG/GIF/WebP case-insensitively for viewer and drop routing.
 */
export const isImagePath = (path: string) => /\.(png|jpe?g|gif|webp)$/i.test(path);
/**
 * Check whether a path is Markdown (or untitled null) for editor routing.
 *
 * Null paths (unsaved/untitled) count as Markdown so live preview applies.
 */
export const isMarkdownPath = (path: string | null) => path === null || /\.(md|markdown)$/i.test(path);
/**
 * Classify a workspace entry to its file kind for tree and tabs.
 *
 * Returns null for directories and binaries so the tree hides them; prefers
 * the native `kind` when present, falling back to extension rules.
 */
export function entryKind(entry: WorkspaceEntry): WorkspaceFileKind | null {
  if (entry.directory) return null;
  if (entry.kind) return entry.kind;
  if (entry.markdown) return "markdown";
  if (isImagePath(entry.path)) return "image";
  if (/\.(txt|text|log|csv|tsv|jsonc?|ya?ml|toml|ini|conf|config|xml|html?|css|scss|less|[cm]?jsx?|tsx?|rs|py|rb|go|java|[ch]|cpp|hpp|cs|swift|kt|sh|bash|zsh|ps1|sql|lua|vim|tex|rst|env)$/i.test(entry.path)
    || /(^|\/)(readme|license|copying|makefile|dockerfile|vimrc|_vimrc|\.vimrc|\.gitignore|\.gitattributes|\.editorconfig|\.env)$/i.test(entry.path)) return "text";
  return null;
}
