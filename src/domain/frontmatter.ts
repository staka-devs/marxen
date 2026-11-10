// Leading YAML frontmatter as note properties (domain).
//
// Markdown parsers here do not know frontmatter, so `---` / `key: v` would
// render as a rule and a setext heading. `maskFrontmatter` blanks it with
// same-length spaces so every offset and line number survives parsing, and
// `frontmatterProperties` exposes flat `key: value` lines for display and
// in-place value edits. Nested YAML (lists, maps) is shown but not edited.

import type { TextEdit } from "../contracts/contracts";

/** One flat property with the UTF-16 range of its raw value text. */
export interface FrontmatterProperty {
  key: string;
  value: string;
  valueFrom: number;
  valueTo: number;
  /** False for nested YAML continuation (lists, maps), which stays read-only. */
  editable: boolean;
}

/** Leading frontmatter block: its end offset (after the closing line) and properties. */
export interface Frontmatter {
  end: number;
  properties: FrontmatterProperty[];
}

/** Find the leading `---` block and its flat properties, or null. */
export function parseFrontmatter(text: string): Frontmatter | null {
  const open = /^---\r?\n/.exec(text);
  if (!open) return null;
  const properties: FrontmatterProperty[] = [];
  let offset = open[0].length;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const lineEnd = newline < 0 ? text.length : newline;
    const line = text.slice(offset, lineEnd).replace(/\r$/, "");
    const next = newline < 0 ? text.length : newline + 1;
    if (line.trimEnd() === "---") return { end: next, properties };
    const match = /^([^\s#:-][^:]*):[ \t]*(.*)$/.exec(line);
    if (match) {
      const raw = match[2].trimEnd();
      const valueFrom = offset + line.length - match[2].length;
      properties.push({ key: match[1].trim(), value: unquote(raw), valueFrom, valueTo: valueFrom + raw.length, editable: true });
    } else if (properties.length > 0 && /^[ \t-]/.test(line)) {
      const last = properties[properties.length - 1];
      last.editable = false;
      last.value = `${last.value}${last.value ? "\n" : ""}${line.trim()}`;
    }
    offset = next;
  }
  return null;
}

/** Strip matching YAML quotes from a scalar. */
function unquote(raw: string): string {
  const double = /^"(.*)"$/.exec(raw);
  if (double) return double[1].replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  const single = /^'(.*)'$/.exec(raw);
  return single ? single[1].replace(/''/g, "'") : raw;
}

/** Quote a value only when YAML would read it differently. */
export function yamlScalar(value: string): string {
  const plain = value !== "" && !/^[\s"'\-?:[\]{}#&*!|>%@`]/.test(value) && !/\s$/.test(value) && !value.includes(": ") && !value.includes(" #");
  return plain ? value : `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

/** Replace the frontmatter's non-newline characters with spaces, keeping offsets and lines. */
export function maskFrontmatter(text: string): string {
  const front = parseFrontmatter(text);
  return front ? text.slice(0, front.end).replace(/[^\r\n]/g, " ") + text.slice(front.end) : text;
}

/** Edit that sets one existing flat property in `text`, offset by `base`; null if absent or nested. */
export function setPropertyEdit(text: string, key: string, value: string, base = 0): TextEdit | null {
  const property = parseFrontmatter(text)?.properties.find((item) => item.key === key && item.editable);
  if (!property || /[\r\n]/.test(value)) return null;
  return { range: { start: base + property.valueFrom, end: base + property.valueTo }, text: yamlScalar(value) };
}
