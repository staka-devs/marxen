// Marxen bundles (domain): a `name.marxen/` folder holding `index.md`, its
// `assets/` and any SQLite files as real files. Packing to `.marxenpack` is a
// native operation; these helpers only recognize bundle paths.

/** Folder suffix that marks a bundle. */
export const BUNDLE_SUFFIX = ".marxen";
/** Folder inside a bundle where pasted and dropped images go. */
export const BUNDLE_ASSETS = "assets";

/** True when the last path segment names a bundle folder. */
export function isBundleFolder(path: string): boolean {
  const name = path.split("/").at(-1) ?? "";
  return name.length > BUNDLE_SUFFIX.length && name.endsWith(BUNDLE_SUFFIX);
}

/** The bundle folder for a bundle folder or its `index.md`, otherwise null. */
export function bundleOf(path: string): string | null {
  if (isBundleFolder(path)) return path;
  const folder = path.endsWith("/index.md") ? path.slice(0, -"/index.md".length) : null;
  return folder && isBundleFolder(folder) ? folder : null;
}
