// Minimal Markdown preview for Issue #5.
//
// Scope: headings, paragraphs, bold/italic/strike/code, links, images,
// bullet/ordered lists, checkboxes, tables, blockquotes, hr, fenced code.
// Full GFM (alerts, footnotes, math, Mermaid), syntax highlight, maps, and
// 3D are Issue #6; this renderer must never execute HTML or scripts.

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function safeUrl(url: string): string {
  const trimmed = url.trim();
  if (/^(https?:|mailto:|#|\/)/i.test(trimmed)) return escapeHtml(trimmed);
  if (/^[\w.\-/+?#=&%:]+$/i.test(trimmed) && !/^\s*javascript:/i.test(trimmed)) return escapeHtml(trimmed);
  return "#";
}

function inline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, src: string) => `<img alt="${alt}" src="${safeUrl(src)}" />`);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, href: string) => `<a href="${safeUrl(href)}">${label}</a>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Italic after bold so `**` is not consumed as two `*`.
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  return out;
}

function tableRow(cells: string[], header: boolean): string {
  const tag = header ? "th" : "td";
  return `<tr>${cells.map((cell) => `<${tag}>${inline(cell.trim())}</${tag}>`).join("")}</tr>`;
}

export function renderMarkdownPreview(src: string): string {
  const lines = src.split("\n");
  let html = "";
  let i = 0;
  let inCode = false;
  let codeBuf: string[] = [];
  let listTag: string | null = null;
  let inTable = false;

  const closeList = () => {
    if (listTag) {
      html += `</${listTag}>`;
      listTag = null;
    }
  };
  const closeTable = () => {
    if (inTable) {
      html += "</tbody></table>";
      inTable = false;
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      if (inCode) {
        html += `<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`;
        codeBuf = [];
        inCode = false;
      } else {
        closeList();
        closeTable();
        inCode = true;
      }
      i += 1;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      i += 1;
      continue;
    }
    if (/^\s*$/.test(line)) {
      closeList();
      closeTable();
      i += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      closeList();
      closeTable();
      const level = heading[1].length;
      html += `<h${level}>${inline(heading[2])}</h${level}>`;
      i += 1;
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      closeList();
      closeTable();
      html += "<hr />";
      i += 1;
      continue;
    }
    if (/^\s*&gt;/.test(line) || /^\s*>/.test(line)) {
      closeList();
      closeTable();
      html += `<blockquote>${inline(line.replace(/^\s*>?\s?/, "").replace(/^&gt;\s?/, ""))}</blockquote>`;
      i += 1;
      continue;
    }
    // Table: header + separator + body.
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      closeList();
      const headerCells = line.split("|").slice(1, -1);
      html += `<table><thead>${tableRow(headerCells, true)}</thead><tbody>`;
      inTable = true;
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        html += tableRow(lines[i].split("|").slice(1, -1), false);
        i += 1;
      }
      closeTable();
      continue;
    }
    const task = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
    if (task) {
      closeTable();
      if (listTag !== "ul") {
        closeList();
        html += "<ul>";
        listTag = "ul";
      }
      const checked = task[1].toLowerCase() === "x" ? " checked" : "";
      html += `<li><input type="checkbox" disabled${checked} /> ${inline(task[2])}</li>`;
      i += 1;
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      closeTable();
      if (listTag !== "ul") {
        closeList();
        html += "<ul>";
        listTag = "ul";
      }
      html += `<li>${inline(bullet[1])}</li>`;
      i += 1;
      continue;
    }
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      closeTable();
      if (listTag !== "ol") {
        closeList();
        html += "<ol>";
        listTag = "ol";
      }
      html += `<li>${inline(ordered[1])}</li>`;
      i += 1;
      continue;
    }
    closeList();
    closeTable();
    html += `<p>${inline(line)}</p>`;
    i += 1;
  }
  closeList();
  closeTable();
  if (inCode) html += `<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`;
  return html;
}
