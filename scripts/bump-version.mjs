// Bump the app version in every file checked by assertVersionConsistency (Issue #116).
// Usage: npm run version:bump -- X.Y.Z

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertVersionConsistency, parseTag, readVersionFiles } from "./release-common.mjs";

// Line-level patterns keep each file's hand formatting; consistency is re-read afterwards.
const TOP_LEVEL_JSON = /^( {2}"version":\s*")[^"]+(")/m;
const PATTERNS = {
  "package.json": [TOP_LEVEL_JSON],
  "package-lock.json": [TOP_LEVEL_JSON, /^( {4}"": \{\s*\n {6}"name": "marxen",\s*\n {6}"version":\s*")[^"]+(")/m],
  [join("src-tauri", "tauri.conf.json")]: [TOP_LEVEL_JSON],
  [join("src-tauri", "Cargo.toml")]: [/^(\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m],
  [join("src-tauri", "Cargo.lock")]: [/^(name\s*=\s*"marxen"\s*\r?\nversion\s*=\s*")[^"]+(")/m],
};

/**
 * Return the rewritten text of each version file, keyed by repository-relative path.
 *
 * Pure so tests can check every location without touching the checkout.
 */
export function bumpVersionTexts(texts, version) {
  parseTag(`v${version}`);
  const out = {};
  for (const [path, patterns] of Object.entries(PATTERNS)) {
    out[path] = patterns.reduce((text, pattern) => replaceOnce(text, pattern, version, path), texts[path]);
  }
  return out;
}

/** Replace the single captured version, failing when the expected layout is missing. */
function replaceOnce(text, pattern, version, label) {
  if (!pattern.test(text)) throw new Error(`${label} version line missing`);
  return text.replace(pattern, `$1${version}$2`);
}

/** Rewrite all version files under `root`, then verify they agree. */
export function bumpVersion(root, version) {
  const paths = Object.keys(PATTERNS);
  const texts = Object.fromEntries(paths.map((path) => [path, readFileSync(join(root, path), "utf8")]));
  // Compute everything before writing so a parse failure leaves no file half-updated.
  const next = bumpVersionTexts(texts, version);
  for (const path of paths) writeFileSync(join(root, path), next[path]);
  assertVersionConsistency(version, readVersionFiles(root));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (!version) {
    console.error("Usage: npm run version:bump -- X.Y.Z");
    process.exit(1);
  }
  bumpVersion(join(dirname(fileURLToPath(import.meta.url)), ".."), version);
  console.log(`Bumped version to ${version}`);
}
