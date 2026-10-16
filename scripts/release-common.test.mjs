import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertArtifacts,
  assertJobs,
  buildReleaseNotes,
  decideReleaseAction,
  extractCargoLockVersion,
  extractCargoPackageVersion,
  formatSha256Sums,
  parseSha256Sums,
  parseTag,
  readVersionFiles,
  assertVersionConsistency,
  selectInstallers,
  selectWorkflowRun,
} from "./release-common.mjs";

/** Build one successful main push Integration run fixture for exact-source tests. */
function successfulRun(overrides = {}) {
  return {
    id: 38856078680,
    name: "Integration",
    path: ".github/workflows/ci.yml",
    head_sha: "086aa022f13163a103d8a33dddafe2dcb0430468",
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    repository: { full_name: "staka-devs/marxen" },
    head_repository: { full_name: "staka-devs/marxen" },
    pull_requests: [],
    ...overrides,
  };
}

/** Build five final installer entries matching the real 0.1.0 bundle names. */
function installerFiles() {
  return [
    { basename: "Marxen_0.1.0_x64-setup.exe", relativePath: "nsis/Marxen_0.1.0_x64-setup.exe", size: 10, isFile: true },
    { basename: "Marxen_0.1.0_amd64.deb", relativePath: "deb/Marxen_0.1.0_amd64.deb", size: 20, isFile: true },
    { basename: "Marxen_0.1.0_amd64.AppImage", relativePath: "appimage/Marxen_0.1.0_amd64.AppImage", size: 30, isFile: true },
    { basename: "Marxen_0.1.0_aarch64.dmg", relativePath: "mac-arm/Marxen_0.1.0_aarch64.dmg", size: 40, isFile: true },
    { basename: "Marxen_0.1.0_x64.dmg", relativePath: "mac-intel/Marxen_0.1.0_x64.dmg", size: 50, isFile: true },
  ];
}

test("strict tags accept vX.Y.Z and reject prerelease or partial forms", () => {
  assert.equal(parseTag("v0.1.0"), "0.1.0");
  for (const bad of ["0.1.0", "v1", "v1.2", "v1.2.3.4", "v01.2.3", "v1.2.3-rc.1", "v1.2.3+build", " v0.1.0", "v0.1.0 "]) {
    assert.throws(() => parseTag(bad));
  }
});

test("cargo version readers use the marxen package without extra parsers", () => {
  assert.equal(extractCargoPackageVersion('[package]\nname = "marxen"\nversion = "0.1.0"\n'), "0.1.0");
  assert.equal(extractCargoLockVersion('[[package]]\nname = "marxen"\nversion = "0.1.0"\n'), "0.1.0");
  assert.throws(() => extractCargoPackageVersion("[lib]\nname = 'x'\n"));
  assert.throws(() => extractCargoLockVersion('[[package]]\nname = "other"\nversion = "1.0.0"\n'));
});

test("repository version files must all equal the tag version", () => {
  const root = mkdtempSync(join(tmpdir(), "marxen-release-"));
  try {
    mkdirSync(join(root, "src-tauri"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.1.0" }));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ version: "0.1.0", packages: { "": { version: "0.1.0" } } }));
    writeFileSync(join(root, "src-tauri", "Cargo.toml"), '[package]\nname = "marxen"\nversion = "0.1.0"\n');
    writeFileSync(join(root, "src-tauri", "tauri.conf.json"), JSON.stringify({ version: "0.1.0" }));
    writeFileSync(join(root, "src-tauri", "Cargo.lock"), '[[package]]\nname = "marxen"\nversion = "0.1.0"\n');
    const versions = readVersionFiles(root);
    assertVersionConsistency("0.1.0", versions);
    assert.throws(() => assertVersionConsistency("0.2.0", versions));
    writeFileSync(join(root, "src-tauri", "tauri.conf.json"), JSON.stringify({ version: "0.2.0" }));
    assert.throws(() => assertVersionConsistency("0.1.0", readVersionFiles(root)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow selection needs exact commit, main push, success, and base repo", () => {
  const sha = "086aa022f13163a103d8a33dddafe2dcb0430468";
  const options = {
    sha,
    repo: "staka-devs/marxen",
    workflowPath: ".github/workflows/ci.yml",
    headBranch: "main",
    event: "push",
  };
  const run = selectWorkflowRun([successfulRun()], options);
  assert.equal(run.id, 38856078680);
  assert.throws(() => selectWorkflowRun([successfulRun({ head_sha: "0".repeat(40) })], options), /No successful/);
  assert.throws(() => selectWorkflowRun([successfulRun({ event: "pull_request" })], options));
  assert.throws(() => selectWorkflowRun([successfulRun({ head_branch: "feature" })], options));
  assert.throws(() => selectWorkflowRun([successfulRun({ conclusion: "failure" })], options));
  assert.throws(() => selectWorkflowRun([successfulRun({ head_repository: { full_name: "fork/marxen" } })], options));
  assert.throws(() => selectWorkflowRun([successfulRun({ pull_requests: [{ number: 1 }] })], options));
  assert.throws(() => selectWorkflowRun([], options));
});

test("native jobs need all four targets completed successfully", () => {
  const jobs = [
    { name: "native (windows-2022, x86_64-pc-windows-msvc, nsis)", status: "completed", conclusion: "success" },
    { name: "native (macos-15, aarch64-apple-darwin, app,dmg)", status: "completed", conclusion: "success" },
    { name: "native (macos-15-intel, x86_64-apple-darwin, app,dmg)", status: "completed", conclusion: "success" },
    { name: "native (ubuntu-24.04, x86_64-unknown-linux-gnu, deb,appimage)", status: "completed", conclusion: "success" },
  ];
  assertJobs(jobs);
  assert.throws(() => assertJobs(jobs.slice(0, 3)), /Expected 4/);
  assert.throws(() => assertJobs([...jobs, { name: "extra", status: "completed", conclusion: "success" }]));
  assert.throws(() => assertJobs(jobs.map((job, index) => (index === 0 ? { ...job, conclusion: "failure" } : job))));
});

test("CI artifacts need four named unexpired payloads without extras", () => {
  const artifacts = [
    { name: "marxen-x86_64-pc-windows-msvc", expired: false, size_in_bytes: 10 },
    { name: "marxen-x86_64-apple-darwin", expired: false, size_in_bytes: 20 },
    { name: "marxen-x86_64-unknown-linux-gnu", expired: false, size_in_bytes: 30 },
    { name: "marxen-aarch64-apple-darwin", expired: false, size_in_bytes: 40 },
  ];
  assertArtifacts(artifacts);
  assert.throws(() => assertArtifacts(artifacts.slice(0, 3)), /missing/);
  assert.throws(() => assertArtifacts([...artifacts, { name: "extra", expired: false, size_in_bytes: 1 }]));
  assert.throws(() => assertArtifacts(artifacts.map(item => ({ ...item, expired: true })), /expired/));
  assert.throws(() => assertArtifacts([artifacts[0], artifacts[0], artifacts[2], artifacts[3]]), /Duplicate/);
});

test("installer selection keeps five final files and rejects intermediates", () => {
  const selected = selectInstallers([
    ...installerFiles(),
    { basename: "bundle_dmg.sh", relativePath: "dmg/bundle_dmg.sh", size: 5, isFile: true },
    { basename: "icon.icns", relativePath: "dmg/icon.icns", size: 5, isFile: true },
    { basename: "marxen", relativePath: "macos/Marxen.app/Contents/MacOS/marxen", size: 5, isFile: true },
  ], "0.1.0");
  assert.deepEqual(selected.map(item => item.slot), [
    "windows-nsis",
    "linux-deb",
    "linux-appimage",
    "mac-arm64-dmg",
    "mac-x64-dmg",
  ]);
  assert.throws(() => selectInstallers(installerFiles().slice(0, 4), "0.1.0"), /Expected exactly 2 dmg/);
  assert.throws(() => selectInstallers([...installerFiles(), {
    basename: "Marxen_0.1.0_x64-setup.exe", relativePath: "copy/Marxen_0.1.0_x64-setup.exe", size: 10, isFile: true,
  }], "0.1.0"), /Duplicate/);
  assert.throws(() => selectInstallers(installerFiles().map(file => ({ ...file, basename: file.basename.replace("0.1.0", "0.2.0") })), "0.1.0"), /missing version/);
  assert.throws(() => selectInstallers([{ basename: "evil.exe", relativePath: "../evil.exe", size: 1, isFile: true }], "0.1.0"), /Path escape/);
  assert.throws(() => selectInstallers([{ basename: "evil.exe", relativePath: "a/evil.exe", size: 1, isFile: true, isSymlink: true }], "0.1.0"), /Symlink/);
  assert.throws(() => selectInstallers([...installerFiles(), {
    basename: "Marxen_0.1.0_amd64.rpm", relativePath: "extra/Marxen_0.1.0_amd64.rpm", size: 1, isFile: true,
  }], "0.1.0"), /Unexpected installer/);
});

test("checksum formatting stays sorted and rejects bad hashes or names", () => {
  const text = formatSha256Sums([
    { basename: "b.dmg", sha256: "b".repeat(64) },
    { basename: "a.exe", sha256: "a".repeat(64) },
  ]);
  assert.equal(text, `${"a".repeat(64)}  a.exe\n${"b".repeat(64)}  b.dmg\n`);
  assert.deepEqual(parseSha256Sums(text).map(entry => entry.basename), ["a.exe", "b.dmg"]);
  assert.throws(() => formatSha256Sums([{ basename: "a.exe", sha256: "short" }]));
  assert.throws(() => parseSha256Sums(`${"a".repeat(64)}  a.exe\nbad-line\n`));
});

test("release notes stay Japanese and name exact assets without agent history", () => {
  const assets = selectInstallers(installerFiles(), "0.1.0");
  const notes = buildReleaseNotes({
    version: "0.1.0",
    tag: "v0.1.0",
    sha: "086aa022f13163a103d8a33dddafe2dcb0430468",
    runId: 38856078680,
    assets,
  });
  for (const file of installerFiles()) assert.ok(notes.includes(file.basename));
  assert.ok(notes.includes("未署名"));
  assert.ok(notes.includes("未検証"));
  assert.ok(!notes.includes("Orca") && !notes.includes("agent"));
});

test("published releases never resolve to overwrite while drafts allow guarded recreate", () => {
  assert.equal(decideReleaseAction(null, { tag: "v0.1.0" }), "create");
  assert.equal(decideReleaseAction({ tagName: "v0.1.0", isDraft: true, isPrerelease: false }, { tag: "v0.1.0" }), "recreate-draft");
  assert.throws(() => decideReleaseAction({ tagName: "v0.1.0", isDraft: false, isPrerelease: false }, { tag: "v0.1.0" }), /published/);
  assert.throws(() => decideReleaseAction({ tagName: "v0.2.0", isDraft: true, isPrerelease: false }, { tag: "v0.1.0" }), /mismatch/);
});
