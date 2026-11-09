// File names for pasted and dropped images (domain).

/** Pad a date part to two digits. */
const two = (value: number) => String(value).padStart(2, "0");

/**
 * Expand an image file-name pattern for one pasted or dropped file.
 *
 * Tokens: `{name}` original name without extension, `{date}` local
 * `YYYY-MM-DD`, `{time}` local `HHmmss`. The original extension is always
 * appended, and characters that cannot appear in a file name become `-`.
 * Same-name files are numbered by the native side, not here.
 */
export function imageFileName(pattern: string, original: string, now: Date): string {
  const dot = original.lastIndexOf(".");
  const stem = dot > 0 ? original.slice(0, dot) : original;
  const extension = dot > 0 ? original.slice(dot + 1).toLowerCase() : "png";
  const date = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  const time = `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  const base = pattern
    .replaceAll("{name}", stem)
    .replaceAll("{date}", date)
    .replaceAll("{time}", time)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/, "")
    .trim();
  return `${base || "image"}.${extension}`;
}
