import { cp, mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { assertSha256, manifest, removeChild, repoRoot, requestedTarget } from "./neovim-common.mjs";

const target = requestedTarget();
const asset = manifest.targets[target];
const cache = join(repoRoot, ".cache", "neovim", manifest.version);
await mkdir(cache, { recursive: true });
const archive = join(cache, asset.asset);
let data;
try { data = await readFile(archive); }
catch (error) {
  if (error.code !== "ENOENT") throw error;
  const url = `https://github.com/neovim/neovim/releases/download/v${manifest.version}/${asset.asset}`;
  console.log(`Downloading ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Neovim download failed: ${response.status}`);
  data = Buffer.from(await response.arrayBuffer());
  assertSha256(data, asset.sha256);
  await writeFile(archive, data);
}
assertSha256(data, asset.sha256); // Recheck cached archives, too.
const staging = await mkdtemp(join(cache, "extract-"));
try {
  const result = spawnSync("tar", ["-xf", archive, "-C", staging], { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Archive extraction failed: ${result.status}`);
  const extracted = join(staging, asset.root);
  await access(join(extracted, asset.executable));
  await access(join(extracted, "share", "nvim", "runtime", "syntax", "markdown.vim"));
  const resources = join(repoRoot, "src-tauri", "resources");
  const destination = join(resources, "neovim");
  await mkdir(resources, { recursive: true });
  await removeChild(resources, destination);
  await cp(extracted, destination, { recursive: true, verbatimSymlinks: true });
  await writeFile(join(destination, "marxen-bundle.json"), JSON.stringify({ version: manifest.version, target, asset: asset.asset, sha256: asset.sha256 }, null, 2) + "\n");
  console.log(`Bundled complete Neovim ${manifest.version} (${target}) at ${destination}`);
} finally {
  await removeChild(cache, staging);
}
