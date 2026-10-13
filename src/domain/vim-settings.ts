// Managed vim-settings model, validation, and block rewrite (domain).
//
// Pure helpers for the Settings GUI: structured settings over the Marxen
// managed Vimscript block. Arbitrary Vimscript outside the block is never
// parsed and always preserved. No Tauri, DOM, React, or browser globals.

import type {
  VimCopyKeys,
  VimMapping,
  VimSettings,
} from "../contracts/vim-settings";

/** Opening marker line of the Marxen-managed region (exact text). */
export const VIM_MANAGED_START = "\" === MARXEN MANAGED START ===";
/** Closing marker line of the Marxen-managed region (exact text). */
export const VIM_MANAGED_END = "\" === MARXEN MANAGED END ===";
/** Human note emitted directly inside the managed region. */
export const VIM_MANAGED_NOTE =
  "\" Managed by Marxen Settings GUI. Do not edit between markers; use Settings or the raw editor.";
/** Vim modes allowed for GUI-managed mappings. */
export const VIM_MAPPING_MODES = ["n", "i", "v", "x", "s", "o", "c", "t"] as const;
/** Maximum mode-specific mappings in one settings value. */
export const VIM_MAX_MAPPINGS = 64;
/** Upper bound for a raw config file accepted by managed operations. */
export const VIM_MAX_CONFIG_BYTES = 512 * 1024;

/**
 * Build the default structured settings for a fresh managed block.
 *
 * Two-space indent with `expandtab`, case-insensitive smart search, a space
 * leader, function-key copy selectors, and no custom mappings.
 */
export function defaultVimSettings(): VimSettings {
  return {
    tabstop: 2,
    shiftwidth: 2,
    expandtab: true,
    ignorecase: true,
    smartcase: true,
    leader: " ",
    mappings: [],
    copyKeys: { markdown: "<F6>", text: "<F7>", rich: "<F8>", html: "<F9>" },
  };
}

/**
 * Report whether a config path selects Lua raw-only handling.
 *
 * Compares only the final segment case-insensitively so picker and manual
 * inputs share one rule; managed Vimscript is never inserted into Lua.
 */
export function isLuaConfigPath(path: string): boolean {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.toLowerCase() === "init.lua";
}

/**
 * Check whether a trimmed line is a Marxen block marker.
 *
 * Markers match after trimming so indented markers still count toward
 * ambiguity detection instead of silently doubling the block.
 */
function isMarker(line: string, marker: string): boolean {
  return line.replace(/\r$/, "").trim() === marker;
}

/**
 * Validate one copy-format selector value, returning a rejection detail.
 *
 * Empty disables the selector. Non-empty values must be a single character
 * or `<...>` notation within 64 bytes, mirroring the native copy-config
 * check so GUI input and sourced behavior agree.
 */
export function validateCopyKey(name: string, value: string): string | null {
  if (value === "") return null;
  if (new TextEncoder().encode(value).length > 64) {
    return `g:marxen_copy_${name}_key: 一つのキーを指定してください。`;
  }
  const single =
    Array.from(value).length === 1 ||
    (value.startsWith("<") && value.endsWith(">") && value.length >= 3 && !/[<>]/.test(value.slice(1, -1)));
  if (!single) return `g:marxen_copy_${name}_key: 一つのキーを指定してください。`;
  if (value.includes("'")) return `g:marxen_copy_${name}_key: 設定コードエディターで指定してください。`;
  const lower = value.toLowerCase();
  const reserved = ["<left>", "<right>", "<up>", "<down>", "<home>", "<end>"].includes(lower);
  const appShortcut = (lower.includes("c-") || lower.includes("d-")) && (lower.endsWith("p>") || lower.endsWith("s>"));
  if (reserved || appShortcut) {
    return `g:marxen_copy_${name}_key: アプリのショートカット・表示行移動のキーは指定できません。`;
  }
  return null;
}

/**
 * Validate one mode-specific mapping, returning a rejection detail.
 *
 * Only `noremap` variants in known modes are managed; anything richer
 * belongs in the raw editor outside the block.
 */
export function validateVimMapping(mapping: VimMapping): string | null {
  if (!(VIM_MAPPING_MODES as readonly string[]).includes(mapping.mode)) {
    return `mapping ${mapping.mode}: モードは n/i/v/x/s/o/c/t で指定してください。`;
  }
  const lhs = Array.from(mapping.lhs).length;
  if (lhs === 0 || lhs > 64) return "mapping: キーは1〜64文字で指定してください。";
  if (/\s/.test(mapping.lhs) || /[\0|]/.test(mapping.lhs) || /[\p{Cc}]/u.test(mapping.lhs)) {
    return mapping.lhs.includes("|")
      ? "mapping: キーに | は使えません（<Bar>を使うか設定コードで編集してください）。"
      : "mapping: キーに空白や制御文字は使えません。";
  }
  const rhs = Array.from(mapping.rhs).length;
  if (rhs === 0 || rhs > 256) return "mapping: 置換内容は1〜256文字で指定してください。";
  if (/[\0\n\r|]/.test(mapping.rhs) || /[\p{Cc}]/u.test(mapping.rhs.replace(/\t/g, ""))) {
    return "mapping: 置換内容に | や改行や制御文字は使えません。";
  }
  return null;
}

/**
 * Collect every settings validation failure in stable field order.
 *
 * Returns an empty list when the settings can be rendered; callers surface
 * the first entry or the whole list without touching the filesystem.
 */
export function validateVimSettings(settings: VimSettings): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(settings.tabstop) || settings.tabstop < 1 || settings.tabstop > 32) {
    errors.push("tabstop は 1〜32 で指定してください。");
  }
  if (!Number.isInteger(settings.shiftwidth) || settings.shiftwidth < 1 || settings.shiftwidth > 32) {
    errors.push("shiftwidth は 1〜32 で指定してください。");
  }
  if (Array.from(settings.leader).length !== 1 || /[\p{Cc}]/u.test(settings.leader)) {
    errors.push("leader は1文字で指定してください。");
  }
  const copies: Array<[string, string]> = [
    ["markdown", settings.copyKeys.markdown],
    ["text", settings.copyKeys.text],
    ["rich", settings.copyKeys.rich],
    ["html", settings.copyKeys.html],
  ];
  for (const [name, value] of copies) {
    const detail = validateCopyKey(name, value);
    if (detail) errors.push(detail);
  }
  const seen = new Map<string, string>();
  for (const [, value] of copies) {
    if (value === "") continue;
    const key = value.toLowerCase();
    if (seen.has(key)) errors.push(`${value}: コピー形式キーと重複しています。`);
    else seen.set(key, value);
  }
  if (settings.mappings.length > VIM_MAX_MAPPINGS) {
    errors.push(`mapping は最大 ${VIM_MAX_MAPPINGS} 件です。`);
  }
  for (const mapping of settings.mappings) {
    const detail = validateVimMapping(mapping);
    if (detail) errors.push(detail);
  }
  const pairs = new Set<string>();
  for (const mapping of settings.mappings) {
    const key = `${mapping.mode}\0${mapping.lhs}`;
    if (pairs.has(key)) errors.push(`mapping ${mapping.mode} ${mapping.lhs}: 重複しています。`);
    else pairs.add(key);
  }
  return errors;
}

/**
 * Escape a leader character for a double-quoted Vimscript string.
 *
 * Backslashes and double quotes gain a backslash prefix; every other
 * character, including Unicode, passes through verbatim.
 */
function escapeLeader(leader: string): string {
  return leader.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

/**
 * Unescape a double- or single-quoted Vimscript leader literal.
 *
 * Returns null when the quoting is malformed so the block is rejected
 * instead of reinterpreted.
 */
function unescapeLeader(quoted: string): string | null {
  if (quoted.startsWith("\"") && quoted.endsWith("\"") && quoted.length >= 2) {
    const inner = quoted.slice(1, -1);
    let out = "";
    for (let i = 0; i < inner.length; i += 1) {
      if (inner[i] === "\\") {
        i += 1;
        if (i >= inner.length) return null;
        out += inner[i];
      } else {
        out += inner[i];
      }
    }
    return out;
  }
  if (quoted.startsWith("'") && quoted.endsWith("'") && quoted.length >= 2) {
    const body = quoted.slice(1, -1);
    return body.includes("'") ? null : body;
  }
  return null;
}

/**
 * Render the canonical managed block lines for validated settings.
 *
 * The leader comes first so `<Leader>` mappings below it resolve; copy
 * selectors follow options; mappings close the block before the end marker.
 */
export function renderManagedBlock(settings: VimSettings): string[] {
  const lines = [
    VIM_MANAGED_START,
    VIM_MANAGED_NOTE,
    `set tabstop=${settings.tabstop}`,
    `set shiftwidth=${settings.shiftwidth}`,
    settings.expandtab ? "set expandtab" : "set noexpandtab",
    settings.ignorecase ? "set ignorecase" : "set noignorecase",
    settings.smartcase ? "set smartcase" : "set nosmartcase",
    `let mapleader="${escapeLeader(settings.leader)}"`,
  ];
  const copies: Array<[string, string]> = [
    ["markdown", settings.copyKeys.markdown],
    ["text", settings.copyKeys.text],
    ["rich", settings.copyKeys.rich],
    ["html", settings.copyKeys.html],
  ];
  for (const [name, value] of copies) lines.push(`let g:marxen_copy_${name}_key='${value}'`);
  for (const mapping of settings.mappings) lines.push(`${mapping.mode}noremap ${mapping.lhs} ${mapping.rhs}`);
  lines.push(VIM_MANAGED_END);
  return lines;
}

/**
 * Locate the managed block line range, rejecting malformed markers.
 *
 * Returns null when no block exists, or the inclusive start/end indices.
 * Duplicate markers, a missing end, or a reversed order are rejections so
 * repeated edits never duplicate the block.
 */
export function findManagedBlock(lines: string[]): { start: number; end: number } | null {
  const starts: number[] = [];
  const ends: number[] = [];
  lines.forEach((line, index) => {
    if (isMarker(line, VIM_MANAGED_START)) starts.push(index);
    if (isMarker(line, VIM_MANAGED_END)) ends.push(index);
  });
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length === 1 && ends.length === 1 && starts[0] < ends[0]) {
    return { start: starts[0], end: ends[0] };
  }
  if (starts.length !== 1 || ends.length !== 1) {
    throw new Error("管理ブロックのマーカーが重複または不足しています。設定コードエディターで1組に修正してください。");
  }
  throw new Error("管理ブロックの開始と終了の順序が正しくありません。設定コードエディターで修正してください。");
}

/**
 * Parse one `set` line's tokens into settings, rejecting unknown options.
 *
 * Combined `set` lines are accepted token-wise; any token outside the owned
 * subset rejects the block so full Vim language is never pretended.
 */
function parseSetTokens(tokens: string[], settings: VimSettings, lineNo: number): void {
  for (const token of tokens) {
    if (token.startsWith("tabstop=")) {
      const value = Number(token.slice("tabstop=".length));
      if (!Number.isInteger(value)) throw new Error(`管理ブロック${lineNo}行目: tabstop の値が正しくありません。`);
      settings.tabstop = value;
    } else if (token.startsWith("shiftwidth=")) {
      const value = Number(token.slice("shiftwidth=".length));
      if (!Number.isInteger(value)) throw new Error(`管理ブロック${lineNo}行目: shiftwidth の値が正しくありません。`);
      settings.shiftwidth = value;
    } else if (token === "expandtab") settings.expandtab = true;
    else if (token === "noexpandtab") settings.expandtab = false;
    else if (token === "ignorecase") settings.ignorecase = true;
    else if (token === "noignorecase") settings.ignorecase = false;
    else if (token === "smartcase") settings.smartcase = true;
    else if (token === "nosmartcase") settings.smartcase = false;
    else throw new Error(`管理ブロック${lineNo}行目: 対応していない設定です（${token}）。ブロック外へ移動するか設定コードで編集してください。`);
  }
}

/**
 * Parse one managed-block body line, rejecting anything outside the subset.
 *
 * Blank lines and `"` comments are skipped; every other line must be an
 * owned `set`, `let`, or `noremap` form.
 */
function parseBlockLine(line: string, settings: VimSettings, lineNo: number): void {
  const trimmed = line.replace(/\r$/, "").trim();
  if (trimmed === "" || trimmed.startsWith("\"")) return;
  if (trimmed.startsWith("set ")) {
    const tokens = trimmed.slice("set ".length).split(/\s+/).filter(Boolean);
    if (tokens.length === 0) throw new Error(`管理ブロック${lineNo}行目: set の内容がありません。`);
    parseSetTokens(tokens, settings, lineNo);
    return;
  }
  if (trimmed.startsWith("let ")) {
    const body = trimmed.slice("let ".length).trim();
    for (const prefix of ["mapleader=", "g:mapleader="]) {
      if (body.startsWith(prefix)) {
        const leader = unescapeLeader(body.slice(prefix.length).trim());
        if (leader === null) throw new Error(`管理ブロック${lineNo}行目: mapleader の引用が正しくありません。`);
        settings.leader = leader;
        return;
      }
    }
    if (body.startsWith("g:marxen_copy_")) {
      const rest = body.slice("g:marxen_copy_".length);
      const split = rest.indexOf("_key=");
      if (split > 0) {
        const name = rest.slice(0, split);
        const quoted = rest.slice(split + "_key=".length).trim();
        let value: string | null = null;
        if (quoted.startsWith("'") && quoted.endsWith("'") && quoted.length >= 2) {
          value = quoted.slice(1, -1);
        } else if (quoted.startsWith("\"") && quoted.endsWith("\"") && quoted.length >= 2) {
          value = unescapeLeader(quoted);
        }
        if (value !== null) {
          const keys = settings.copyKeys as unknown as Record<string, string>;
          if (name === "markdown" || name === "text" || name === "rich" || name === "html") {
            keys[name] = value;
            return;
          }
          throw new Error(`管理ブロック${lineNo}行目: 対応していないコピー形式です（${name}）。`);
        }
        throw new Error(`管理ブロック${lineNo}行目: コピー形式キーの引用が正しくありません。`);
      }
    }
    throw new Error(`管理ブロック${lineNo}行目: 対応していない let です。ブロック外へ移動してください。`);
  }
  for (const mode of VIM_MAPPING_MODES) {
    const prefix = `${mode}noremap `;
    if (trimmed.startsWith(prefix)) {
      const rest = trimmed.slice(prefix.length).trim();
      const gap = rest.search(/\s/);
      if (gap <= 0 || rest.slice(gap).trim() === "") {
        throw new Error(`管理ブロック${lineNo}行目: mapping の形式が正しくありません。`);
      }
      settings.mappings.push({ mode, lhs: rest.slice(0, gap), rhs: rest.slice(gap).trim() });
      return;
    }
  }
  throw new Error(`管理ブロック${lineNo}行目: 対応していない行です（${trimmed}）。ブロック外へ移動してください。`);
}

/**
 * Parse the managed block of raw file text into structured settings.
 *
 * Returns null when no block exists. Rejects duplicate/missing markers and
 * any body line outside the owned subset so unknown Vim language is never
 * silently reinterpreted.
 */
export function parseManagedBlock(raw: string): VimSettings | null {
  const lines = raw.split("\n");
  const found = findManagedBlock(lines);
  if (!found) return null;
  const settings = defaultVimSettings();
  for (let i = found.start + 1; i < found.end; i += 1) {
    parseBlockLine(lines[i], settings, i + 1);
  }
  return settings;
}

/**
 * Rewrite raw file text with canonical managed settings.
 *
 * Validates the new settings first, refuses Lua targets, rejects malformed
 * existing blocks, appends a fresh block when missing, and replaces the
 * block in place otherwise. Unknown text outside the block is preserved;
 * repeated calls with the same settings are idempotent.
 */
export function rewriteManagedBlock(raw: string, settings: VimSettings, isLua: boolean): string {
  if (isLua) throw new Error("init.lua は設定コード編集のみです。管理ブロックを挿入しません。");
  const failures = validateVimSettings(settings);
  if (failures.length > 0) throw new Error(failures[0]);
  // Reject an ambiguous existing block before discarding anything.
  parseManagedBlock(raw);
  const block = renderManagedBlock(settings).join("\n");
  if (raw === "") return `${block}\n`;
  const lines = raw.split("\n");
  const found = findManagedBlock(lines);
  if (!found) {
    const separator = raw.endsWith("\n") ? "" : "\n";
    return `${raw}${separator}${block}\n`;
  }
  const before = lines.slice(0, found.start).join("\n");
  const after = lines.slice(found.end + 1).join("\n");
  let result = "";
  if (before !== "") result += `${before}\n`;
  result += `${block}\n`;
  result += after;
  if (after !== "" && !after.endsWith("\n")) result += "\n";
  return result;
}

/**
 * Preview a managed rewrite without writing, reporting change state.
 *
 * Returns the rewritten text and whether it differs from the input; throws
 * the same validation, Lua, and malformed-block errors as the rewrite so
 * the panel inspects exactly what saving would do.
 */
export function previewManagedChange(
  raw: string,
  settings: VimSettings,
  isLua: boolean,
): { next: string; changed: boolean } {
  const next = rewriteManagedBlock(raw, settings, isLua);
  return { next, changed: next !== raw };
}

/** Copy-format field names in stable display order. */
export const VIM_COPY_FORMATS = ["markdown", "text", "rich", "html"] as const;

/**
 * Read a copy-format value from structured settings by field name.
 *
 * Treats unknown names as empty so review rows never throw on new fields.
 */
export function copyKeyOf(settings: VimSettings, name: string): string {
  const keys = settings.copyKeys as unknown as Record<string, string>;
  return typeof keys[name] === "string" ? keys[name] : "";
}

/**
 * Replace one copy-format value, returning a new settings object.
 *
 * Unknown field names leave the settings unchanged.
 */
export function withCopyKey(settings: VimSettings, name: string, value: string): VimSettings {
  if (name !== "markdown" && name !== "text" && name !== "rich" && name !== "html") return settings;
  return { ...settings, copyKeys: { ...settings.copyKeys, [name]: value } as VimCopyKeys };
}
