import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { hostTarget, manifest, repoRoot, requestedTarget } from "./neovim-common.mjs";

const target = requestedTarget();
if (target !== hostTarget()) throw new Error("Run the real Neovim smoke test on its native OS/architecture");
const root = join(repoRoot, "src-tauri", "resources", "neovim");
const metadata = JSON.parse(await readFile(join(root, "marxen-bundle.json"), "utf8"));
if (metadata.target !== target || metadata.version !== manifest.version || metadata.sha256 !== manifest.targets[target].sha256) throw new Error("Wrong Neovim bundle; rerun bundle:neovim");
const [major, minor, patch] = manifest.version.split(".").map(Number);
const lua = `lua local v=vim.version(); assert(v.major==${major} and v.minor==${minor} and v.patch==${patch}); assert(vim.fn.filereadable(vim.env.VIMRUNTIME..'/syntax/markdown.vim')==1); vim.api.nvim_buf_set_lines(0,0,-1,true,{'日本語😀'}); assert(vim.api.nvim_buf_get_lines(0,0,-1,true)[1]=='日本語😀'); print('MARXEN_NVIM_RUNTIME_OK')`;
const result = spawnSync(join(root, manifest.targets[target].executable), ["--headless", "-u", "NONE", "-i", "NONE", "-n", "-c", lua, "-c", "qa!"], {
  env: { ...process.env, VIMRUNTIME: join(root, "share", "nvim", "runtime") }, encoding: "utf8", timeout: 30_000, windowsHide: true,
});
if (result.error) throw result.error;
const output = result.stdout + result.stderr;
if (result.status !== 0 || !output.includes("MARXEN_NVIM_RUNTIME_OK")) throw new Error(`Real Neovim smoke test failed (${result.status}): ${output}`);
console.log(`Real Neovim ${manifest.version} runtime and Japanese/emoji buffer smoke passed (${target}).`);
