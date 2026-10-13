// Generated from src-tauri/src/contracts/vim_settings.rs. Run the export-vim-settings-contracts helper.
// Do not edit by hand. Vim-settings IPC schema version 1.
export type VimMapping = { mode: string, lhs: string, rhs: string, };
export type VimCopyKeys = { markdown: string, text: string, rich: string, html: string, };
export type VimSettings = { tabstop: number, shiftwidth: number, expandtab: boolean, ignorecase: boolean, smartcase: boolean, leader: string, mappings: Array<VimMapping>, copyKeys: VimCopyKeys, };
export type VimConfigRead = { path: string, 
/**
 * Hex SHA-256 of the exact file bytes, absent when the file is missing.
 */
fingerprint: string | null, 
/**
 * Whether the selected configuration file exists.
 */
exists: boolean, 
/**
 * True for `init.lua`: raw editing only, never managed Vimscript.
 */
isLua: boolean, raw: string, settings: VimSettings, 
/**
 * Managed-block parse failure, if any; the raw text stays inspectable.
 */
managedError: string | null, };
export type VimConfigWrite = { path: string, fingerprint: string, raw: string, };
