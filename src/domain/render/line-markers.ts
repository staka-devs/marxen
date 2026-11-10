// Line-start Markdown markers of the block under the cursor (Issue #6).
//
// List bullets, task boxes and quote markers at the start of each line, with
// UTF-16 ranges into the block text, so the live editor can draw them as
// bullets, checkboxes and quote bars on lines the cursor is not on.

/** One line-start marker; `markerFrom..markerTo` is the text it replaces. */
export interface LineMarker {
  kind: "bullet" | "ordered" | "task" | "quote";
  /** Offset of the line start in the block text. */
  lineFrom: number;
  markerFrom: number;
  markerTo: number;
  /** Ordered-list number text such as `1.`. */
  label?: string;
  /** Task state. */
  checked?: boolean;
}

const QUOTE = /^(?:[ \t]{0,3}>[ \t]?)+/;
const LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(\[([ xX])\][ \t]+)?/;

/**
 * Markers at the start of each line of `text`, in line order.
 *
 * Quote markers come first on a line; a list marker after them is reported
 * separately. Indentation before a list marker is kept visible.
 */
export function lineMarkers(text: string): LineMarker[] {
  const markers: LineMarker[] = [];
  let lineFrom = 0;
  for (const line of text.split("\n")) {
    let rest = line;
    let offset = lineFrom;
    const quote = QUOTE.exec(rest);
    if (quote) {
      markers.push({ kind: "quote", lineFrom, markerFrom: offset, markerTo: offset + quote[0].length });
      offset += quote[0].length;
      rest = rest.slice(quote[0].length);
    }
    const list = LIST.exec(rest);
    if (list) {
      const markerFrom = offset + list[1].length;
      const bulletTo = markerFrom + list[2].length + list[3].length;
      if (list[4]) {
        markers.push({ kind: "task", lineFrom, markerFrom, markerTo: bulletTo + list[4].length, checked: list[5] !== " " });
      } else if (/\d/.test(list[2])) {
        markers.push({ kind: "ordered", lineFrom, markerFrom, markerTo: bulletTo, label: list[2] });
      } else {
        markers.push({ kind: "bullet", lineFrom, markerFrom, markerTo: bulletTo });
      }
    }
    lineFrom += line.length + 1;
  }
  return markers;
}
