import { readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const manifest = JSON.parse(await readFile(new URL("./neovim-manifest.json", import.meta.url), "utf8"));

export function hostTarget(platform = process.platform, arch = process.arch) {
  const targets = { "win32-x64": "x86_64-pc-windows-msvc", "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin", "linux-x64": "x86_64-unknown-linux-gnu" };
  const target = targets[`${platform}-${arch}`];
  if (!target) throw new Error(`Unsupported Neovim host: ${platform}/${arch}`);
  return target;
}

export function requestedTarget(args = process.argv.slice(2)) {
  if (args.length === 0) return hostTarget();
  if (args.length !== 2 || args[0] !== "--target" || !Object.hasOwn(manifest.targets, args[1])) throw new Error("Usage: --target <supported Rust target>");
  return args[1];
}

export function assertSha256(data, expected) {
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== expected) throw new Error(`Neovim SHA-256 mismatch: expected ${expected}, got ${actual}`);
}

export async function removeChild(parent, child) {
  const root = resolve(parent);
  const target = resolve(child);
  if (!target.startsWith(root + sep)) throw new Error(`Refusing to remove outside ${root}: ${target}`);
  await rm(target, { recursive: true, force: true });
}
