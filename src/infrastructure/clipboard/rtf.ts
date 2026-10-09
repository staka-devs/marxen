/**
 * Escape text for RTF output, preserving emoji as UTF-16 escapes.
 *
 * Backslashes/braces are escaped; newlines become `\line`; non-ASCII becomes
 * `\uN?` so Word/Outlook keep emoji instead of dropping them.
 */
function escapeRtf(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 92 || code === 123 || code === 125) result += "\\" + text[index];
    else if (code === 10) result += "\\line ";
    else if (code === 13) continue;
    else if (code === 9) result += "\\tab ";
    else if (code > 127) result += `\\u${code > 32767 ? code - 65536 : code}?`;
    else result += text[index];
  }
  return result;
}

/**
 * Convert one embedded image to an inline RTF pict block, scaling to 640px.
 *
 * PNG dimensions come from the header; JPEG/GIF/WebP decode via `Image`
 * (10s timeout) and non-JPEG rasters convert through canvas to PNG. Oversize
 * or invalid images throw Japanese errors instead of pasting broken bytes.
 */
async function picture(img: HTMLImageElement): Promise<string> {
  let source = img.getAttribute("src") ?? "";
  if (!/^data:image\/(png|jpeg|gif|webp);base64,/i.test(source)) return escapeRtf(img.alt);
  let kind = "pngblip";
  let width = 0;
  let height = 0;
  if (/^data:image\/png;base64,/i.test(source)) {
    const binary = atob(source.slice(source.indexOf(",") + 1));
    const bytes = Uint8Array.from(binary.slice(0, 24), (char) => char.charCodeAt(0));
    if (bytes.length < 24) throw new Error("コピー画像の PNG ヘッダーが不正です。");
    const view = new DataView(bytes.buffer);
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else {
    const decoded = new Image();
    decoded.src = source;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        decoded.decode(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("コピー画像の読み込みがタイムアウトしました。")), 10_000); }),
      ]);
      width = decoded.naturalWidth;
      height = decoded.naturalHeight;
      if (/^data:image\/jpeg;base64,/i.test(source)) kind = "jpegblip";
      else {
        if (width * height > 40_000_000) throw new Error("コピー画像の寸法が大きすぎます。");
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("コピー画像の変換に失敗しました。");
        context.drawImage(decoded, 0, 0);
        source = canvas.toDataURL("image/png");
      }
    } finally {
      clearTimeout(timer);
    }
  }
  if (width === 0 || height === 0 || width > 32768 || height > 32768) throw new Error("コピー画像の寸法が不正です。");
  const binary = atob(source.slice(source.indexOf(",") + 1));
  const hex = Array.from(binary, (char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  const scale = Math.min(1, 640 / width);
  return `{\\pict\\${kind}\\picw${width}\\pich${height}\\picwgoal${Math.round(width * scale * 15)}\\pichgoal${Math.round(height * scale * 15)} ${hex}}`;
}

/**
 * Convert a sanitized clipboard fragment to RTF for Word/Outlook targets.
 *
 * Includes image bytes in-place (base64 HTML images do not travel); math
 * keeps authored TeX as readable text; tables/lists map to RTF constructs.
 * Whitespace-only text in block containers is dropped to avoid blank runs.
 */
export async function htmlToRtf(root: DocumentFragment): Promise<string> {
  const walk = async (node: Node): Promise<string> => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? "";
      if (value.trim() === "" && (!node.parentElement || ["TABLE", "THEAD", "TBODY", "TR", "UL", "OL", "DIV"].includes(node.parentElement.tagName))) return "";
      return escapeRtf(value);
    }
    if (!(node instanceof Element)) return "";
    // RTF has no portable SVG/math representation. Preserve the authored TeX
    // as readable text rather than dropping a formula from native paste.
    if (node.tagName.toLowerCase() === "mjx-container") return escapeRtf(node.getAttribute("data-marxen-tex") ?? "");
    if (node.tagName === "IMG") return picture(node as HTMLImageElement);
    if (node.tagName === "BR") return "\\line ";
    if (node.tagName === "INPUT") return (node as HTMLInputElement).checked ? "[x]" : "[ ]";
    let inner = "";
    for (const child of node.childNodes) inner += await walk(child);
    switch (node.tagName) {
      case "STRONG": case "B": return `{\\b ${inner}}`;
      case "EM": case "I": return `{\\i ${inner}}`;
      case "U": return `{\\ul ${inner}}`;
      case "A": {
        const href = node.getAttribute("href");
        if (!href) return inner;
        const target = escapeRtf(href).replaceAll('"', "\\'22");
        return `{\\field{\\*\\fldinst HYPERLINK "${target}"}{\\fldrslt{\\ul ${inner}}}}`;
      }
      case "DEL": case "S": return `{\\strike ${inner}}`;
      case "CODE": return `{\\f1 ${inner}}`;
      case "PRE": return `{\\f1 ${inner}}\\par\n`;
      case "H1": return `{\\b\\fs36 ${inner}}\\par\n`;
      case "H2": return `{\\b\\fs30 ${inner}}\\par\n`;
      case "H3": case "H4": case "H5": case "H6": return `{\\b\\fs26 ${inner}}\\par\n`;
      case "P": return `${inner}\\par\n`;
      case "LI": {
        const parent = node.parentElement;
        if (parent?.tagName === "OL") {
          const start = Number(parent.getAttribute("start") ?? 1);
          const index = [...parent.children].filter((child) => child.tagName === "LI").indexOf(node);
          return `${(Number.isFinite(start) ? start : 1) + index}.\\tab ${inner}\\par\n`;
        }
        return `\\bullet\\tab ${inner}\\par\n`;
      }
      case "BLOCKQUOTE": return `{\\li360 ${inner}}\\par\n`;
      case "TH": return `{\\b ${inner}}\\cell `;
      case "TD": return `${inner}\\cell `;
      case "TR": {
        const cells = [...node.children].filter((child) => ["TH", "TD"].includes(child.tagName));
        const edges = cells.map((_, index) => `\\cellx${(index + 1) * Math.floor(9000 / Math.max(cells.length, 1))}`).join("");
        return `{\\trowd\\trgaph108${edges}\\intbl ${inner}\\row}\n`;
      }
      default: return inner;
    }
  };
  let content = "";
  for (const child of root.childNodes) content += await walk(child);
  return `{\\rtf1\\ansi\\deff0\\uc1{\\fonttbl{\\f0 Segoe UI;}{\\f1 Consolas;}}\\f0\\fs22 ${content}}`;
}
