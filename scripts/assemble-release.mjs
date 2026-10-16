import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  buildReleaseNotes,
  cliArg,
  collectArtifactFiles,
  formatSha256Sums,
  parseSha256Sums,
  parseTag,
  selectInstallers,
  sha256File,
} from "./release-common.mjs";

const argv = process.argv.slice(2);
const artifactsDir = resolve(cliArg(argv, "artifacts"));
const outDir = resolve(cliArg(argv, "out"));
const tag = cliArg(argv, "tag");
const sha = cliArg(argv, "sha");
const runId = cliArg(argv, "run-id");
if (argv.some(item => item.startsWith("--") && !["--artifacts", "--out", "--tag", "--sha", "--run-id"].includes(item))) {
  throw new Error(`Unknown argument in ${argv.join(" ")}`);
}

const version = parseTag(tag);
if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`SHA must be 40-char hex: ${sha}`);
if (!(Number(runId) > 0)) throw new Error(`Run id must be positive: ${runId}`);

const files = collectArtifactFiles(artifactsDir);
const selected = selectInstallers(files, version);
mkdirSync(outDir, { recursive: true });
const pairs = [];
for (const item of selected) {
  const source = resolve(item.fullPath ?? join(artifactsDir, item.relativePath));
  const target = join(outDir, item.basename);
  if (basename(target) !== item.basename) throw new Error(`Unsafe output name: ${item.basename}`);
  copyFileSync(source, target);
  pairs.push({ basename: item.basename, sha256: sha256File(target) });
}
const sums = formatSha256Sums(pairs);
parseSha256Sums(sums);
writeFileSync(join(outDir, "SHA256SUMS"), sums);
const notes = buildReleaseNotes({ version, tag, sha, runId: Number(runId), assets: selected });
writeFileSync(join(outDir, "release-notes.md"), notes);
console.log(`Assembled ${selected.length} installers plus SHA256SUMS for ${tag}.`);
