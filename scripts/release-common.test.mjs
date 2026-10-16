import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertArtifacts,
  assertCompleteList,
  assertDraftAssets,
  assertJobs,
  assetDigestHex,
  buildReleaseNotes,
  collectVerifyLocals,
  decideReleaseAction,
  expectedReleaseFiles,
  extractCargoLockVersion,
  extractCargoPackageVersion,
  formatSha256Sums,
  ghApiArgs,
  isReleaseNotFound,
  parseSha256Sums,
  parseTag,
  readVersionFiles,
  assertVersionConsistency,
  resolveTagCommit,
  runValidate,
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

/** Build five final installer entries with exact owners for version 0.1.0. */
function installerFiles() {
  return [
    { basename: "Marxen_0.1.0_x64-portable.zip", relativePath: "marxen-x86_64-pc-windows-msvc/portable/Marxen_0.1.0_x64-portable.zip", size: 60, isFile: true },
    { basename: "Marxen_0.1.0_x64-setup.exe", relativePath: "marxen-x86_64-pc-windows-msvc/nsis/Marxen_0.1.0_x64-setup.exe", size: 10, isFile: true },
    { basename: "Marxen_0.1.0_amd64.deb", relativePath: "marxen-x86_64-unknown-linux-gnu/deb/Marxen_0.1.0_amd64.deb", size: 20, isFile: true },
    { basename: "Marxen_0.1.0_amd64.AppImage", relativePath: "marxen-x86_64-unknown-linux-gnu/appimage/Marxen_0.1.0_amd64.AppImage", size: 30, isFile: true },
    { basename: "Marxen_0.1.0_aarch64.dmg", relativePath: "marxen-aarch64-apple-darwin/dmg/Marxen_0.1.0_aarch64.dmg", size: 40, isFile: true },
    { basename: "Marxen_0.1.0_x64.dmg", relativePath: "marxen-x86_64-apple-darwin/dmg/Marxen_0.1.0_x64.dmg", size: 50, isFile: true },
  ];
}

/** Build six local files including SHA256SUMS for draft verification tests. */
function localSix() {
  const five = installerFiles().map((file, index) => ({ ...file, sha256: String(index + 1).repeat(64) }));
  return [...five, { basename: "SHA256SUMS", sha256: "f".repeat(64), size: 100 }];
}

/** Build a matching draft asset list with uploaded state and digests. */
function draftFor(locals, overrides = {}) {
  return {
    tagName: "v0.1.0",
    isDraft: true,
    isPrerelease: false,
    assets: locals.map(item => ({ name: item.basename, size: item.size, state: "uploaded", digest: `sha256:${item.sha256}` })),
    ...overrides,
  };
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
  assert.equal(selectWorkflowRun([successfulRun()], options).id, 38856078680);
  assert.throws(() => selectWorkflowRun([successfulRun({ head_sha: "0".repeat(40) })], options), /No successful/);
  assert.throws(() => selectWorkflowRun([successfulRun({ event: "pull_request" })], options));
  assert.throws(() => selectWorkflowRun([successfulRun({ conclusion: "failure" })], options));
  assert.throws(() => selectWorkflowRun([successfulRun({ head_repository: { full_name: "fork/marxen" } })], options));
  assert.throws(() => selectWorkflowRun([], options));
});

test("paged lists fail closed on hidden pages", () => {
  assertCompleteList(1, [{}], "runs");
  assert.throws(() => assertCompleteList(2, [{}], "runs"), /Incomplete/);
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
  assert.throws(() => assertArtifacts(artifacts.map(item => ({ ...item, expired: true })), /expired/));
});

test("installers require exact names and owners, rejecting substrings and wrong sources", () => {
  const selected = selectInstallers([
    ...installerFiles(),
    { basename: "bundle_dmg.sh", relativePath: "marxen-aarch64-apple-darwin/dmg/bundle_dmg.sh", size: 5, isFile: true },
    { basename: "Marxen.app", relativePath: "marxen-aarch64-apple-darwin/macos/Marxen.app", size: 5, isFile: false },
  ], "0.1.0");
  assert.deepEqual(selected.map(item => item.slot), ["windows-portable", "windows-nsis", "linux-deb", "linux-appimage", "mac-arm64-dmg", "mac-x64-dmg"]);
  assert.deepEqual(expectedReleaseFiles("0.1.0").map(item => item.basename), installerFiles().map(file => file.basename));
  const wrongVersion = installerFiles().map(file => ({
    ...file,
    basename: file.basename.replace("0.1.0", "10.1.0"),
    relativePath: file.relativePath.replace("0.1.0", "10.1.0"),
  }));
  assert.throws(() => selectInstallers(wrongVersion, "0.1.0"), /Unexpected installer|Missing installers/);
  const wrongOwner = installerFiles().map(file => (
    file.basename.endsWith(".exe") ? { ...file, relativePath: "marxen-x86_64-unknown-linux-gnu/nsis/Marxen_0.1.0_x64-setup.exe" } : file
  ));
  assert.throws(() => selectInstallers(wrongOwner, "0.1.0"), /Wrong source artifact/);
  assert.throws(() => selectInstallers(installerFiles().slice(0, 4), "0.1.0"), /Missing installers/);
  assert.throws(() => selectInstallers([...installerFiles(), installerFiles()[0]], "0.1.0"), /Duplicate/);
});

test("checksum formatting stays sorted and rejects bad hashes or names", () => {
  const text = formatSha256Sums([
    { basename: "b.dmg", sha256: "b".repeat(64) },
    { basename: "a.exe", sha256: "a".repeat(64) },
  ]);
  assert.equal(text, `${"a".repeat(64)}  a.exe\n${"b".repeat(64)}  b.dmg\n`);
  assert.deepEqual(parseSha256Sums(text).map(entry => entry.basename), ["a.exe", "b.dmg"]);
  assert.throws(() => formatSha256Sums([{ basename: "a.exe", sha256: "short" }]));
});

test("release notes name exact assets without agent history", () => {
  const notes = buildReleaseNotes({
    version: "0.1.0",
    tag: "v0.1.0",
    sha: "086aa022f13163a103d8a33dddafe2dcb0430468",
    runId: 38856078680,
    assets: selectInstallers(installerFiles(), "0.1.0"),
  });
  for (const file of installerFiles()) assert.ok(notes.includes(file.basename));
  assert.ok(!notes.includes("Orca"));
});

test("existing releases fail closed without automatic recovery", () => {
  assert.equal(decideReleaseAction(null, { tag: "v0.1.0" }), "create");
  assert.throws(() => decideReleaseAction({ tagName: "v0.1.0", isDraft: true, isPrerelease: false }, { tag: "v0.1.0" }), /already exists/);
  assert.throws(() => decideReleaseAction({ tagName: "v0.1.0", isDraft: false, isPrerelease: false }, { tag: "v0.1.0" }), /already exists/);
  assert.ok(isReleaseNotFound("release not found"));
  assert.ok(isReleaseNotFound("Not Found (HTTP 404)"));
  assert.ok(!isReleaseNotFound("HTTP 401: bad credentials"));
  assert.equal(assetDigestHex(`sha256:${"a".repeat(64)}`), "a".repeat(64));
  assert.throws(() => assetDigestHex("nohex"), /Bad asset digest/);
  assert.throws(() => assetDigestHex("a".repeat(64)), /Bad asset digest/);
  assert.throws(() => assetDigestHex(`sha256:${"z".repeat(64)}`), /Bad asset digest/);
  assert.throws(() => assetDigestHex(`sha256:${"a".repeat(63)}`), /Bad asset digest/);
});

test("draft assets must match local names, sizes, and digests", () => {
  const locals = localSix();
  assertDraftAssets(draftFor(locals), locals, { tag: "v0.1.0" });
  assert.throws(() => assertDraftAssets(draftFor(locals.slice(0, 5)), locals, { tag: "v0.1.0" }), /count mismatch/);
  const badHash = draftFor(locals);
  badHash.assets[0] = { ...badHash.assets[0], digest: `sha256:${"0".repeat(64)}` };
  assert.throws(() => assertDraftAssets(badHash, locals, { tag: "v0.1.0" }), /hash mismatch/);
  const badState = draftFor(locals);
  badState.assets[1] = { ...badState.assets[1], state: "open" };
  assert.throws(() => assertDraftAssets(badState, locals, { tag: "v0.1.0" }), /not uploaded/);
  assert.throws(() => assertDraftAssets({ ...draftFor(locals), isDraft: false }, locals, { tag: "v0.1.0" }), /published/);
  const duplicated = draftFor(locals);
  duplicated.assets[1] = { ...duplicated.assets[0] };
  assert.throws(() => assertDraftAssets(duplicated, locals, { tag: "v0.1.0" }), /Duplicate draft assets/);
  const sha = "086aa022f13163a103d8a33dddafe2dcb0430468";
  assertDraftAssets({ ...draftFor(locals), targetCommitish: sha }, locals, { tag: "v0.1.0", sha });
  assert.throws(() => assertDraftAssets({ ...draftFor(locals), targetCommitish: "0".repeat(40) }, locals, { tag: "v0.1.0", sha }), /source mismatch/);
  assertDraftAssets({ ...draftFor(locals), targetCommitish: "main" }, locals, { tag: "v0.1.0", sha });
});

test("api argv forces GET so -f parameters stay a query string", () => {
  /** Model gh's rule that -f without an explicit method becomes POST. */
  const ghMethod = (args) => {
    const at = args.indexOf("--method");
    if (at >= 0) return args[at + 1];
    return args.includes("-f") ? "POST" : "GET";
  };
  const args = ghApiArgs("repos/o/r/actions/workflows/ci.yml/runs", [["head_sha", "a".repeat(40)], ["per_page", "20"]]);
  assert.deepEqual(args, ["api", "--method", "GET", "repos/o/r/actions/workflows/ci.yml/runs", "-f", `head_sha=${"a".repeat(40)}`, "-f", "per_page=20"]);
  assert.equal(ghMethod(args), "GET");
  assert.equal(ghMethod(["api", "repos/o/r/actions/workflows/ci.yml/runs", "-f", "head_sha=abc"]), "POST");
});

test("assembled output collects six publish files for draft validation", () => {
  const dist = mkdtempSync(join(tmpdir(), "marxen-dist-"));
  try {
    const contents = new Map();
    for (const item of expectedReleaseFiles("0.1.0")) {
      const data = Buffer.from(`payload-${item.basename}\n`);
      writeFileSync(join(dist, item.basename), data);
      contents.set(item.basename, data);
    }
    const pairs = [...contents].map(([basename, data]) => ({ basename, sha256: createHash("sha256").update(data).digest("hex") }));
    writeFileSync(join(dist, "SHA256SUMS"), formatSha256Sums(pairs));
    const locals = collectVerifyLocals(dist);
    assert.equal(locals.length, 7);
    assertDraftAssets({
      tagName: "v0.1.0",
      isDraft: true,
      isPrerelease: false,
      assets: locals.map(item => ({ name: item.basename, size: item.size, state: "uploaded", digest: `sha256:${item.sha256}` })),
    }, locals, { tag: "v0.1.0" });
    const fiveOnly = locals.filter(item => item.basename !== "SHA256SUMS");
    assert.equal(fiveOnly.length, 6);
    assert.throws(() => assertDraftAssets({
      tagName: "v0.1.0",
      isDraft: true,
      isPrerelease: false,
      assets: locals.map(item => ({ name: item.basename, size: item.size, state: "uploaded", digest: `sha256:${item.sha256}` })),
    }, fiveOnly, { tag: "v0.1.0" }), /count mismatch/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("tag resolution supports lightweight and annotated tags in an isolated repo", () => {
  const root = mkdtempSync(join(tmpdir(), "marxen-git-"));
  try {
    /** Run git inside the isolated tag fixture. */
    const git = (args) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
      return String(result.stdout).trim();
    };
    git(["init", "-q"]);
    git(["config", "user.email", "test@test.test"]);
    git(["config", "user.name", "test"]);
    writeFileSync(join(root, "f.txt"), "x\n");
    git(["add", "f.txt"]);
    git(["commit", "-qm", "init"]);
    const head = git(["rev-parse", "HEAD"]);
    git(["tag", "v9.9.99"]);
    assert.equal(resolveTagCommit("v9.9.99", root), head);
    git(["tag", "-a", "v9.9.98", "-m", "annotated"]);
    assert.equal(resolveTagCommit("v9.9.98", root), head);
    const broken = spawnSync("git", ["rev-list", "-n", "1", "--", "v9.9.99"], { cwd: root, encoding: "utf8" });
    assert.notEqual(broken.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validate uses GET and exact source with a controlled gh boundary", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "marxen-validate-"));
  try {
    mkdirSync(join(repoRoot, "src-tauri"), { recursive: true });
    writeFileSync(join(repoRoot, "package.json"), JSON.stringify({ version: "9.9.99" }));
    writeFileSync(join(repoRoot, "package-lock.json"), JSON.stringify({ version: "9.9.99", packages: { "": { version: "9.9.99" } } }));
    writeFileSync(join(repoRoot, "src-tauri", "Cargo.toml"), '[package]\nname = "marxen"\nversion = "9.9.99"\n');
    writeFileSync(join(repoRoot, "src-tauri", "tauri.conf.json"), JSON.stringify({ version: "9.9.99" }));
    writeFileSync(join(repoRoot, "src-tauri", "Cargo.lock"), '[[package]]\nname = "marxen"\nversion = "9.9.99"\n');
    /** Run git inside the isolated validate fixture. */
    const git = (args) => {
      const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
      return String(result.stdout).trim();
    };
    git(["init", "-q"]);
    git(["config", "user.email", "test@test.test"]);
    git(["config", "user.name", "test"]);
    git(["add", "."]);
    git(["commit", "-qm", "init"]);
    git(["tag", "v9.9.99"]);
    const sha = git(["rev-parse", "HEAD"]);
    const seen = [];
    /** Serve canned CI responses while asserting exact-source parameters. */
    const ghGet = (path, fields) => {
      seen.push([path, fields]);
      const params = Object.fromEntries(fields);
      if (path.endsWith("workflows/ci.yml/runs")) {
        assert.equal(params.head_sha, sha);
        assert.equal(params.branch, "main");
        assert.equal(params.event, "push");
        return JSON.stringify({ total_count: 1, workflow_runs: [{ id: 7, name: "Integration", path: ".github/workflows/ci.yml", head_sha: sha, head_branch: "main", event: "push", status: "completed", conclusion: "success", repository: { full_name: "test-owner/test-repo" }, head_repository: { full_name: "test-owner/test-repo" }, pull_requests: [] }] });
      }
      if (path.endsWith("/jobs")) {
        return JSON.stringify({ total_count: 4, jobs: ["x86_64-pc-windows-msvc", "aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-unknown-linux-gnu"].map(target => ({ name: `native (${target})`, status: "completed", conclusion: "success" })) });
      }
      return JSON.stringify({ total_count: 4, artifacts: ["marxen-x86_64-pc-windows-msvc", "marxen-x86_64-apple-darwin", "marxen-aarch64-apple-darwin", "marxen-x86_64-unknown-linux-gnu"].map(name => ({ name, expired: false, size_in_bytes: 10 })) });
    };
    /** Simulate an absent release for the isolated tag. */
    const viewRelease = () => ({ status: 1, stdout: "", stderr: "release not found" });
    /** Reject unwired gh access to prove the GET boundary. */
    const rejectingGhGet = () => { throw new Error("POST without explicit GET"); };
    const result = runValidate(
      ["--tag", "v9.9.99", "--repo", "test-owner/test-repo", "--root", repoRoot],
      {},
      { ghGet, viewRelease },
    );
    assert.equal(result.runId, 7);
    assert.equal(result.sha, sha);
    assert.ok(seen.length >= 3);
    assert.throws(() => runValidate(
      ["--tag", "v9.9.99", "--repo", "test-owner/test-repo", "--root", repoRoot],
      {},
      { ghGet: rejectingGhGet, viewRelease },
    ), /POST without explicit GET/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
