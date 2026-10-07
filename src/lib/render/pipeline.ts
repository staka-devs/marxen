// Shared remark/rehype rendering pipeline (Issue #6).
//
// One pipeline serves live and read modes so both views share the same
// syntax tree and source ranges. All libraries run locally (no CDN):
// GFM (remark-gfm), five GitHub alerts, footnotes, Shiki, MathJax (SVG,
// compile time), Mermaid / Leaflet / Three.js (client hydration of trusted
// placeholders). Raw HTML passes through rehype-raw + an extended
// GitHub sanitize schema. Malformed special blocks keep their raw source
// with a visible Japanese error and never block editing.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkGithubAlert from "remark-github-blockquote-alert";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeMathjax from "rehype-mathjax";
import rehypeStringify from "rehype-stringify";
import { visit } from "unist-util-visit";
import type { Element, Properties, Root } from "hast";
import type { Root as MdastRoot, Content as MdastContent } from "mdast";
import type { VFile } from "vfile";
import { highlightCode } from "./shiki";
import { marxenSanitizeSchema } from "./sanitize-schema";
import { isSpecialLanguage, type RenderDiagnostic, type RenderResult, type SourceBlock } from "./types";
import {
  validateGeoJson,
  validateMathContent,
  validateMermaidStructure,
  validateTopoJson,
  validateAsciiStl,
  type BlockValidation,
} from "./validate";

const DIAGNOSTICS_KEY = "marxenDiagnostics";

function pushDiagnostic(file: VFile, diagnostic: RenderDiagnostic): void {
  const existing = file.data[DIAGNOSTICS_KEY];
  if (Array.isArray(existing)) existing.push(diagnostic);
  else file.data[DIAGNOSTICS_KEY] = [diagnostic];
}

function readDiagnostics(file: VFile): RenderDiagnostic[] {
  const value = file.data[DIAGNOSTICS_KEY];
  return Array.isArray(value) ? (value as RenderDiagnostic[]) : [];
}

function classList(properties: Properties | undefined): string[] {
  const value = properties?.className;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return [value];
  return [];
}

function hasClass(node: Element, name: string): boolean {
  return classList(node.properties).includes(name);
}

/** Concatenated text of an element subtree (code content is plain text). */
function elementText(node: Element): string {
  let out = "";
  const walk = (current: Element | { type: string; value?: string; children?: unknown[] }): void => {
    if (current.type === "text" && typeof current.value === "string") out += current.value;
    const children = (current as { children?: unknown[] }).children;
    if (Array.isArray(children)) for (const child of children) walk(child as Element);
  };
  walk(node);
  return out;
}

function positionOf(node: { position?: { start: { line: number }; end: { line: number } } | undefined }): {
  startLine: number | null;
  endLine: number | null;
} {
  const position = node.position;
  if (!position) return { startLine: null, endLine: null };
  return { startLine: position.start.line, endLine: position.end.line };
}

interface RawNode {
  type: "raw";
  value: string;
}

function textNode(value: string): { type: "text"; value: string } {
  return { type: "text", value };
}

function element(tagName: string, properties: Properties, children: Array<Element | RawNode | { type: "text"; value: string }>): Element {
  return { type: "element", tagName, properties, children: children as Element["children"] };
}

function wrapperDiv(kind: string, source: { startLine: number | null; endLine: number | null }, extra: Properties, children: Element["children"]): Element {
  const properties: Properties = { className: ["marxen-special"], dataMarxenKind: kind, ...extra };
  if (source.startLine !== null) properties.dataSourceStartLine = source.startLine;
  if (source.endLine !== null) properties.dataSourceEndLine = source.endLine;
  return { type: "element", tagName: "div", properties, children };
}

const KIND_LABEL: Record<string, string> = {
  mermaid: "Mermaid 図",
  geojson: "地図 (GeoJSON)",
  topojson: "地図 (TopoJSON)",
  stl: "3D (STL)",
  math: "数式",
};

function rawSourceBlock(source: string): Element {
  return element("pre", { className: ["marxen-raw"] }, [
    element("code", { className: ["marxen-raw-text"] }, [textNode(source)]),
  ]);
}

function errorBox(message: string): Element {
  return element("div", { className: ["marxen-error"], role: "alert" }, [textNode(message)]);
}

function rawDetails(source: string): Element {
  return element("details", { className: ["marxen-source"] }, [
    element("summary", {}, [textNode("原文を表示")]),
    rawSourceBlock(source),
  ]);
}

/** Pre-MathJax pass: malformed TeX keeps raw text with a visible error. */
function rehypeValidateMath() {
  return (tree: Root, file: VFile) => {
    const replacements: Array<{ parent: Element | Root; index: number; node: Element; inline: boolean; source: string }> = [];
    visit(tree, "element", (node: Element, index: number | undefined, parent: Element | Root | undefined) => {
      if (!parent || index === undefined) return;
      if (node.tagName === "pre") {
        const children = node.children.filter((child) => child.type === "element") as Element[];
        if (children.length === 1 && children[0].tagName === "code" && hasClass(children[0], "language-math")) {
          replacements.push({ parent, index, node, inline: false, source: elementText(children[0]) });
        }
        return;
      }
      if (node.tagName === "code" && hasClass(node, "language-math") && (parent as Element).tagName !== "pre") {
        replacements.push({ parent, index, node, inline: true, source: elementText(node) });
      }
    });
    // Reverse order keeps collected indices valid within shared parents.
    for (const item of replacements.reverse()) {
      const validation = validateMathContent(item.source);
      if (validation.ok) continue;
      const lines = positionOf(item.node);
      pushDiagnostic(file, { code: "math-invalid", message: validation.message ?? "数式が不正です。", startLine: lines.startLine, endLine: lines.endLine });
      const siblings = (item.parent as Element).children ?? (item.parent as Root).children;
      if (item.inline) {
        siblings.splice(
          item.index,
          1,
          element("span", { className: ["marxen-error"], role: "alert" }, [textNode(validation.message ?? "数式が不正です。")]) as never,
          element("code", { className: ["marxen-raw-text"] }, [textNode(item.source)]) as never,
        );
      } else {
        siblings.splice(
          item.index,
          1,
          wrapperDiv("math", lines, { dataInvalid: "true" }, [
            errorBox(validation.message ?? "数式が不正です。"),
            rawSourceBlock(item.source),
          ]) as never,
        );
      }
    }
  };
}

const SPECIAL_CONTAINER_CLASS: Record<string, string> = {
  mermaid: "marxen-mermaid-output",
  geojson: "marxen-map",
  topojson: "marxen-map",
  stl: "marxen-stl",
};

/** Post-MathJax pass: special fenced blocks and Shiki highlighting. */
function rehypeMarxenBlocks() {
  return async (tree: Root, file: VFile) => {
    const targets: Array<{ parent: Element | Root; index: number; pre: Element; code: Element; lang: string }> = [];
    visit(tree, "element", (node: Element, index: number | undefined, parent: Element | Root | undefined) => {
      if (node.tagName !== "pre" || !parent || index === undefined) return;
      const children = node.children.filter((child) => child.type === "element") as Element[];
      if (children.length !== 1 || children[0].tagName !== "code") return;
      const code = children[0];
      const langClass = classList(code.properties).find((name) => name.startsWith("language-"));
      if (!langClass) return;
      targets.push({ parent, index, pre: node, code, lang: langClass.slice("language-".length).toLowerCase() });
    });

    for (const target of targets) {
      const siblings = (target.parent as Element).children ?? (target.parent as Root).children;
      const source = elementText(target.code);
      // Strip one trailing newline that remark keeps for fenced blocks so
      // validators and hydration see the author's exact content.
      const normalized = source.replace(/\n$/, "");
      const lines = positionOf(target.pre);
      const startProp = lines.startLine !== null ? { dataSourceStartLine: lines.startLine } : {};
      const endProp = lines.endLine !== null ? { dataSourceEndLine: lines.endLine } : {};

      if (isSpecialLanguage(target.lang)) {
        let validation: BlockValidation;
        let topoObject: string | undefined;
        switch (target.lang) {
          case "mermaid":
            validation = validateMermaidStructure(normalized);
            break;
          case "geojson":
            validation = validateGeoJson(normalized);
            break;
          case "topojson": {
            const topo = validateTopoJson(normalized);
            validation = topo;
            topoObject = topo.ok ? topo.objectNames?.[0] : undefined;
            break;
          }
          default:
            validation = validateAsciiStl(normalized);
            break;
        }
        if (!validation.ok) {
          pushDiagnostic(file, {
            code: `${target.lang}-invalid` as RenderDiagnostic["code"],
            message: validation.message ?? "ブロックが不正です。",
            startLine: lines.startLine,
            endLine: lines.endLine,
          });
        }
        const extra: Properties = validation.ok ? {} : { dataInvalid: "true" };
        if (topoObject) {
          extra.dataTopoObject = topoObject;
        }
        const children: Element["children"] = [
          element("p", { className: ["marxen-special-title"] }, [textNode(KIND_LABEL[target.lang] ?? target.lang)]),
        ];
        if (validation.ok) {
          children.push(element("div", { className: [SPECIAL_CONTAINER_CLASS[target.lang]] }, []));
          children.push(rawDetails(normalized));
        } else {
          children.push(errorBox(validation.message ?? "ブロックが不正です。"));
          children.push(rawSourceBlock(normalized));
        }
        siblings.splice(target.index, 1, wrapperDiv(target.lang, lines, extra, children) as never);
        continue;
      }

      if (target.lang === "math") {
        // Validated earlier; MathJax already rendered valid math. Anything
        // left here is defensive: keep the raw text visible.
        siblings.splice(target.index, 1, wrapperDiv("math", lines, {}, [rawSourceBlock(normalized)]) as never);
        continue;
      }

      const highlighted = await highlightCode(normalized, target.lang);
      if (highlighted) {
        const holder = element("div", { className: ["marxen-codeblock"], ...startProp, ...endProp }, [
          { type: "raw", value: highlighted } as RawNode as never,
        ]);
        siblings.splice(target.index, 1, holder as never);
      } else {
        const holder = element("div", { className: ["marxen-codeblock"], ...startProp, ...endProp }, [
          element("p", { className: ["marxen-codeblock-note"] }, [textNode(`「${target.lang}」の強調表示には対応していません。原文のまま表示します。`)]),
          element("pre", {}, [element("code", { className: [`language-${target.lang}`] }, [textNode(normalized)])]),
        ]);
        siblings.splice(target.index, 1, holder as never);
      }
    }
  };
}

const RANGE_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "ul", "ol", "li", "table", "blockquote", "pre", "hr", "section", "details", "div",
]);

/** Stamp shared source ranges so live/read map blocks to原文 lines. */
function rehypeSourceRanges() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (!RANGE_TAGS.has(node.tagName)) return;
      if (!node.position) return;
      if (node.properties.dataSourceStartLine === undefined) {
        node.properties.dataSourceStartLine = node.position.start.line;
      }
      if (node.properties.dataSourceEndLine === undefined) {
        node.properties.dataSourceEndLine = node.position.end.line;
      }
    });
  };
}

export type { RenderDiagnostic, RenderResult, SourceBlock } from "./types";

let processor: ReturnType<typeof buildProcessor> | null = null;

function buildProcessor() {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkGithubAlert)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, marxenSanitizeSchema() as never)
    .use(rehypeValidateMath)
    .use(rehypeMathjax)
    .use(rehypeMarxenBlocks)
    .use(rehypeSourceRanges)
    // Trusted `raw` nodes are generated after sanitization from escaped
    // source (Shiki); dangerous author HTML stays disabled upstream.
    .use(rehypeStringify, { allowDangerousHtml: true });
}

function getProcessor(): ReturnType<typeof buildProcessor> {
  if (!processor) {
    processor = buildProcessor();
  }
  return processor;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Render Markdown to sanitized local-only HTML with diagnostics and blocks. Never throws. */
export async function renderMarkdownDocument(source: string): Promise<RenderResult> {
  const blocks = parseMarkdownBlocks(source);
  try {
    const file = await getProcessor().process(source);
    return { html: String(file), diagnostics: readDiagnostics(file), blocks };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      html: `<div class="marxen-error" role="alert">描画できませんでした。原文は保持されています。${escapeHtml(message)}</div><pre>${escapeHtml(source)}</pre>`,
      diagnostics: [],
      blocks,
    };
  }
}

function mdastText(node: MdastContent): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if ("children" in node && Array.isArray(node.children)) {
    return (node.children as MdastContent[]).map(mdastText).join("");
  }
  return "";
}

function alertKind(node: MdastContent): string | null {
  if (node.type !== "blockquote") return null;
  const first = node.children[0];
  if (!first || first.type !== "paragraph") return null;
  const text = mdastText(first);
  const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.exec(text.trim());
  return match ? match[1].toLowerCase() : null;
}

/** Top-level source blocks with 1-based lines for live/read mapping. */
export function parseMarkdownBlocks(source: string): SourceBlock[] {
  try {
    const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(source) as MdastRoot;
    const blocks: SourceBlock[] = [];
    for (const node of tree.children) {
      const position = node.position;
      if (!position) continue;
      const startLine = position.start.line;
      const endLine = position.end.line;
      switch (node.type) {
        case "heading":
          blocks.push({ kind: "heading", startLine, endLine, title: mdastText(node).slice(0, 60) });
          break;
        case "code": {
          const lang = node.lang ? `code:${node.lang.toLowerCase()}` : "code";
          blocks.push({ kind: lang, startLine, endLine });
          break;
        }
        case "math":
          blocks.push({ kind: "math", startLine, endLine });
          break;
        case "table":
          blocks.push({ kind: "table", startLine, endLine });
          break;
        case "list":
          blocks.push({ kind: "list", startLine, endLine });
          break;
        case "blockquote": {
          const kind = alertKind(node);
          blocks.push({ kind: kind ? `alert:${kind}` : "blockquote", startLine, endLine });
          break;
        }
        case "paragraph":
          blocks.push({ kind: "paragraph", startLine, endLine, title: mdastText(node).slice(0, 60) });
          break;
        case "thematicBreak":
          blocks.push({ kind: "rule", startLine, endLine });
          break;
        case "footnoteDefinition":
          blocks.push({ kind: "footnote", startLine, endLine });
          break;
        default:
          blocks.push({ kind: node.type, startLine, endLine });
          break;
      }
    }
    return blocks;
  } catch {
    return [];
  }
}
