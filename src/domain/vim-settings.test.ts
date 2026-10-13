import { describe, expect, it } from "vitest";
import {
  defaultVimSettings,
  isLuaConfigPath,
  parseManagedBlock,
  previewManagedChange,
  rewriteManagedBlock,
  validateCopyKey,
  validateVimMapping,
  validateVimSettings,
  VIM_MANAGED_END,
  VIM_MANAGED_START,
} from "./vim-settings";

describe("vim-settings domain", () => {
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
