// Sanitization policy for Issue #6 (rehype-sanitize schema).
//
// Base: the GitHub-flavored default (relative links/images pass,
// `javascript:` / event handlers / script / iframe are stripped).
// Extensions keep the Issue #6 feature set alive through sanitization:
// five GitHub alert kinds (div/p classes + octicon svg), ruby-free CJK
// content, and footnote link integrity. MathJax/Shiki/special-block HTML is
// generated AFTER sanitization from escaped source, so `mjx-*` and `style`
// never need to pass through here.

import { defaultSchema } from "hast-util-sanitize";

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
  return {
    ...base,
    tagNames: [...(base.tagNames ?? []), "svg", "path"],
    attributes: attributes as SanitizeSchema["attributes"],
    // remark-rehype already prefixes footnote ids with `user-content-`;
    // the default clobber pass would prefix them twice and break
    // footnote forward/back links (`#user-content-fn-a` -> nowhere).
    clobberPrefix: "",
  };
}
