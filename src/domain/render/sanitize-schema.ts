// Sanitization policy for Issue #6 (rehype-sanitize schema, ADR-0060).
//
// Base: the GitHub-flavored default (relative links/images pass,
// `javascript:` / `vbscript:` / event handlers / script / iframe are
// stripped). `data:` is rejected for `href` (navigation executes) but
// allowed for image `src` (static image context never executes scripts,
// and pasted screenshots need it). Extensions keep the feature set alive:
// five GitHub alert kinds (div/p classes + octicon svg), ruby-free CJK
// content, and footnote link integrity. MathJax/Shiki/special-block HTML is
// generated AFTER sanitization from escaped source, so `mjx-*` and `style`
// never need to pass through here.
//
// DOM clobbering: every `id` / `name` gets the `marxen-` prefix so user
// HTML can never shadow `window` / `document` properties (`location`,
// `cookie`, ...). Same-document `#fragment` links are rewritten to the
// prefixed targets by `rehypeMatchFragmentLinks` in pipeline.ts.

import { defaultSchema } from "hast-util-sanitize";

export const CLOBBER_PREFIX = "marxen-";

export interface SanitizeSchema {
  tagNames?: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attributes?: Record<string, any>;
  protocols?: Record<string, string[]>;
  clobber?: string[];
  clobberPrefix?: string;
  strip?: string[];
}

const ALERT_CLASSES = [
  "markdown-alert",
  "markdown-alert-note",
  "markdown-alert-tip",
  "markdown-alert-important",
  "markdown-alert-warning",
  "markdown-alert-caution",
];

/**
 * Build the GitHub-based sanitize schema with Marxen extensions.
 *
 * Allows alert classes, octicon SVG, and `data:` image sources while keeping
 * `data:` links rejected; prefixes ids with `marxen-` against clobbering.
 */
export function marxenSanitizeSchema(): SanitizeSchema {
  const base = defaultSchema as SanitizeSchema;
  const attributes: Record<string, unknown> = { ...(base.attributes ?? {}) };
  const divAttrs = [...((attributes.div as unknown[]) ?? [])];
  // One `className` entry: findDefinition uses the first match only, with
  // the remaining items as the allow list for each class value.
  divAttrs.push(["className", ...ALERT_CLASSES]);
  attributes.div = divAttrs;
  attributes.p = [...((attributes.p as unknown[]) ?? []), ["className", "markdown-alert-title"]];
  attributes.svg = [
    ["className", "octicon"],
    "viewBox",
    "width",
    "height",
    "ariaHidden",
  ];
  attributes.path = ["d"];
  attributes.span = [...((attributes.span as unknown[]) ?? []), ["className", "sr-only"]];
  const protocols: Record<string, string[]> = { ...(base.protocols ?? {}) };
  // `data:` images stay (static context, pasted screenshots); `data:` links
  // stay rejected so `data:text/html` can never become navigation + script.
  protocols.src = [...(protocols.src ?? []), "data"];
  return {
    ...base,
    tagNames: [...(base.tagNames ?? []), "svg", "path"],
    attributes: attributes as SanitizeSchema["attributes"],
    protocols,
    // Every id/name is prefixed so user HTML cannot clobber window/document
    // members. Fragment hrefs are repointed to the prefixed ids by
    // `rehypeMatchFragmentLinks`, keeping footnotes and author anchors live.
    clobberPrefix: CLOBBER_PREFIX,
  };
}
