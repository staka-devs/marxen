import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bumpVersion } from "./bump-version.mjs";
import { readVersionFiles } from "./release-common.mjs";

const FILES = ["package.json", "package-lock.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"];

/** Copy the real version files into a scratch checkout. */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "marxen-bump-"));
  mkdirSync(join(root, "src-tauri"));
  for (const file of FILES) cpSync(file, join(root, file));
  return root;
}

test("bumpVersion updates all six locations consistently", () => {
  const root = scratch();
  try {
    bumpVersion(root, "9.8.7");
    assert.deepEqual(Object.values(readVersionFiles(root)), Array(6).fill("9.8.7"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bumpVersion to the current version leaves every file byte-identical", () => {
  const root = scratch();
  try {
    bumpVersion(root, readVersionFiles(root).packageJson);
    for (const file of FILES) assert.equal(readFileSync(join(root, file), "utf8"), readFileSync(file, "utf8"), file);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bumpVersion rejects non X.Y.Z input without writing", () => {
  const root = scratch();
  try {
    assert.throws(() => bumpVersion(root, "1.2"));
    for (const file of FILES) assert.equal(readFileSync(join(root, file), "utf8"), readFileSync(file, "utf8"), file);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
