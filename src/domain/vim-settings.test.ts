import { describe, expect, it } from "vitest";
import {
  defaultVimSettings,
  displayVimLeader,
  parseVimLeaderInput,
  isLuaConfigPath,
  parseManagedBlock,
  previewManagedChange,
  renderManagedBlock,
  rewriteManagedBlock,
  validateCopyKey,
  validateVimMapping,
  validateVimSettings,
  VIM_MANAGED_END,
  VIM_MANAGED_START,
} from "./vim-settings";

describe("vim-settings domain", () => {
  it("defaults the selection popup off and changes only its managed config flag", () => {
    const settings = { ...defaultVimSettings(), selectionToolbar: true };
    const raw = '" outside 日本😀\r\n' + renderManagedBlock(defaultVimSettings()).join("\r\n") + '\r\n" tail';
    const next = rewriteManagedBlock(raw, settings, false);
    expect(next).toBe(raw.replace("marxen_selection_toolbar=0", "marxen_selection_toolbar=1"));
    expect(parseManagedBlock(next)?.selectionToolbar).toBe(true);
    expect(() => parseManagedBlock(next.replace("marxen_selection_toolbar=1", "marxen_selection_toolbar=2"))).toThrow();
    expect(defaultVimSettings().selectionToolbar).toBe(false);
  });
  it.each([
    { prefix: "\n\n", suffix: "", newline: "\n", terminator: "" },
    { prefix: "\r\n\r\n", suffix: '" 外側 日本語', newline: "\r\n", terminator: "\r\n" },
    { prefix: '" 日本語 🎉\r\nset number\r\n', suffix: "nnoremap j gj\r\n", newline: "\r\n", terminator: "\r\n" },
    { prefix: "", suffix: "", newline: "\n", terminator: "" },
    { prefix: "\n", suffix: "\n\n", newline: "\n", terminator: "\n" },
  ])("splices only the managed region, preserving exact unmanaged bytes: %j", ({ prefix, suffix, newline, terminator }) => {
    const original = renderManagedBlock(defaultVimSettings()).join(newline);
    const raw = `${prefix}${original}${terminator}${suffix}`;
    const settings = { ...defaultVimSettings(), leader: "," };
    const next = rewriteManagedBlock(raw, settings, false);
    const expected = `${prefix}${renderManagedBlock(settings).join(newline)}${terminator}${suffix}`;
    expect(new TextEncoder().encode(next)).toEqual(new TextEncoder().encode(expected));
    expect(rewriteManagedBlock(next, settings, false)).toBe(next);
  });

  it.each([["set number", "\n"], ['" 日本語\r\nset number', "\r\n"]])("adds only a necessary separator when inserting a missing block into %j", (raw, newline) => {
    const next = rewriteManagedBlock(raw, defaultVimSettings(), false);
    expect(next).toBe(`${raw}${newline}${renderManagedBlock(defaultVimSettings()).join(newline)}${newline}`);
    expect(rewriteManagedBlock(next, defaultVimSettings(), false)).toBe(next);
  });

  it.each([" ", "\\", ",", ";", "界", "🚀", "\"", "'"])("round-trips the real %j leader through presentation and safe Vimscript", (leader) => {
    expect(parseVimLeaderInput(displayVimLeader(leader))).toBe(leader);
    const settings = { ...defaultVimSettings(), leader, mappings: [{ mode: "n", lhs: "<Leader>w", rhs: ":w<CR>" }] };
    expect(validateVimSettings(settings)).toEqual([]);
    const raw = rewriteManagedBlock("", settings, false);
    expect(parseManagedBlock(raw)).toEqual(settings);
    if (leader === " ") {
      expect(displayVimLeader(leader)).toBe("<Space>");
      expect(raw).toContain('let mapleader=" "');
      expect(raw).not.toContain('let mapleader="<Space>"');
    }
  });

  it("normalizes only Space notation and rejects other notation or arbitrary code", () => {
    for (const input of ["<Space>", "<space>", "<SPACE>", " "]) expect(parseVimLeaderInput(input)).toBe(" ");
    for (const input of ["<Tab>", "ab", "", "\n", '" | quit', " <Space> "]) {
      const leader = parseVimLeaderInput(input);
      expect(leader).toBe(input);
      expect(validateVimSettings({ ...defaultVimSettings(), leader })).not.toHaveLength(0);
      expect(() => rewriteManagedBlock("", { ...defaultVimSettings(), leader }, false)).toThrow();
    }
  });

  it("appends one block to an empty file and stays idempotent", () => {
    const settings = defaultVimSettings();
    const once = rewriteManagedBlock("", settings, false);
    expect(once).toContain(VIM_MANAGED_START);
    expect(once).toContain(VIM_MANAGED_END);
    expect(once.match(/MARXEN MANAGED START/g)).toHaveLength(1);
    expect(rewriteManagedBlock(once, settings, false)).toBe(once);
  });

  it("preserves Unicode and unknown commands outside the block", () => {
    const raw = "\" 日本語コメント 🎉 絵文字\nset number\nnnoremap j gj\nlet g:opaque = {'a': [1, 2]}\n";
    const rewritten = rewriteManagedBlock(raw, defaultVimSettings(), false);
    expect(rewritten).toContain("\" 日本語コメント 🎉 絵文字");
    expect(rewritten).toContain("set number");
    expect(rewritten).toContain("nnoremap j gj");
    expect(rewritten).toContain("let g:opaque = {'a': [1, 2]}");
    expect(rewritten.match(/MARXEN MANAGED START/g)).toHaveLength(1);
  });

  it("round-trips structured settings through the managed block", () => {
    const settings = {
      ...defaultVimSettings(),
      tabstop: 4,
      shiftwidth: 4,
      expandtab: false,
      ignorecase: false,
      smartcase: false,
      leader: ",",
      mappings: [{ mode: "n", lhs: "<Leader>w", rhs: ":w<CR>" }],
      copyKeys: { markdown: "<F6>", text: "", rich: "<F8>", html: "<F9>" },
    };
    const raw = rewriteManagedBlock("", settings, false);
    expect(parseManagedBlock(raw)).toEqual(settings);
  });

  it("rejects malformed and ambiguous marker blocks", () => {
    const settings = defaultVimSettings();
    const duplicated = `${VIM_MANAGED_START}\nset tabstop=2\n${VIM_MANAGED_END}\n${VIM_MANAGED_START}\n${VIM_MANAGED_END}\n`;
    expect(() => rewriteManagedBlock(duplicated, settings, false)).toThrow();
    expect(() => rewriteManagedBlock(`${VIM_MANAGED_START}\nset tabstop=2\n`, settings, false)).toThrow();
    expect(() => rewriteManagedBlock(`${VIM_MANAGED_END}\n${VIM_MANAGED_START}\n`, settings, false)).toThrow();
    expect(() => parseManagedBlock(`${VIM_MANAGED_START}\nset tabstop=2\n`)).toThrow();
  });

  it("rejects unknown lines inside the block instead of reinterpreting Vim", () => {
    const raw = `${VIM_MANAGED_START}\nset number\n${VIM_MANAGED_END}\n`;
    expect(() => parseManagedBlock(raw)).toThrow();
    expect(() => rewriteManagedBlock(raw, defaultVimSettings(), false)).toThrow();
  });

  it("keeps init.lua raw-only and never inserts Vimscript", () => {
    expect(isLuaConfigPath("C:\\cfg\\init.lua")).toBe(true);
    expect(isLuaConfigPath("/cfg/INIT.LUA")).toBe(true);
    expect(isLuaConfigPath("/cfg/.vimrc")).toBe(false);
    expect(() => rewriteManagedBlock("vim.opt.number = true\n", defaultVimSettings(), true)).toThrow();
  });

  it("rejects invalid options, duplicate mappings, and reserved keys", () => {
    expect(validateVimSettings({ ...defaultVimSettings(), tabstop: 0 })).not.toHaveLength(0);
    expect(validateVimSettings({ ...defaultVimSettings(), leader: "" })).not.toHaveLength(0);
    expect(validateVimSettings({ ...defaultVimSettings(), leader: "ab" })).not.toHaveLength(0);
    const dupMappings = {
      ...defaultVimSettings(),
      mappings: [
        { mode: "n", lhs: "jj", rhs: "<Esc>" },
        { mode: "n", lhs: "jj", rhs: "<Esc>" },
      ],
    };
    expect(validateVimSettings(dupMappings).some((e) => e.includes("重複"))).toBe(true);
    const dupKeys = {
      ...defaultVimSettings(),
      copyKeys: { markdown: "<F6>", text: "<f6>", rich: "<F8>", html: "<F9>" },
    };
    expect(validateVimSettings(dupKeys).some((e) => e.includes("重複"))).toBe(true);
    expect(validateCopyKey("markdown", "<Left>")).not.toBeNull();
    expect(validateCopyKey("markdown", "<C-p>")).not.toBeNull();
    expect(validateCopyKey("markdown", "")).toBeNull();
    expect(validateVimMapping({ mode: "x", lhs: "a|b", rhs: ":w" })).not.toBeNull();
    expect(validateVimMapping({ mode: "z", lhs: "a", rhs: "b" })).not.toBeNull();
    expect(validateVimMapping({ mode: "i", lhs: "jj", rhs: "<Esc>" })).toBeNull();
  });

  it("previews changes without writing", () => {
    const { next, changed } = previewManagedChange("", defaultVimSettings(), false);
    expect(changed).toBe(true);
    expect(previewManagedChange(next, defaultVimSettings(), false).changed).toBe(false);
    expect(next).toBe(rewriteManagedBlock("", defaultVimSettings(), false));
  });

  it("accepts emoji and Japanese text in mapping bodies", () => {
    const settings = {
      ...defaultVimSettings(),
      mappings: [{ mode: "i", lhs: "eee", rhs: "絵文字🎉" }],
    };
    expect(validateVimSettings(settings)).toEqual([]);
    const parsed = parseManagedBlock(rewriteManagedBlock("", settings, false));
    expect(parsed?.mappings).toEqual(settings.mappings);
  });
});
