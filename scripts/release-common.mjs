/** Validators for the version-tag release workflow. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readFileSync as readBinarySync } from "node:fs";
import { join, relative } from "node:path";

export const RELEASE_WORKFLOW_PATH = ".github/workflows/ci.yml";
export const RELEASE_WORKFLOW_NAME = "Integration";
export const RELEASE_HEAD_BRANCH = "main";
export const RELEASE_HEAD_EVENT = "push";
export const RELEASE_EXPECTED_TARGETS = [
  "x86_64-pc-windows-msvc",
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu",
];
export const RELEASE_EXPECTED_ARTIFACTS = [
  "marxen-x86_64-pc-windows-msvc",
  "marxen-x86_64-apple-darwin",
  "marxen-aarch64-apple-darwin",
  "marxen-x86_64-unknown-linux-gnu",
];

/** Parse a strict version tag of the form vX.Y.Z and return the bare version. */
export function parseTag(tag) {
  if (typeof tag !== "string") throw new Error(`Tag must be a string: ${String(tag)}`);
  const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(tag);
  if (!match) throw new Error(`Tag must match vX.Y.Z without prerelease: ${tag}`);
  return match[1];
}

/** Read repository version files from a checkout root without network access. */
export function readVersionFiles(root) {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const packageLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const cargoToml = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8");
  const tauriConf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  const cargoLock = readFileSync(join(root, "src-tauri", "Cargo.lock"), "utf8");
  const cargoVersion = extractCargoPackageVersion(cargoToml);
  const cargoLockVersion = extractCargoLockVersion(cargoLock);
  return {
    packageJson: String(packageJson.version ?? ""),
    packageLockRoot: String(packageLock.version ?? ""),
    packageLockTop: String(packageLock.packages?.[""]?.version ?? ""),
    cargoToml: cargoVersion,
    tauriConf: String(tauriConf.version ?? ""),
    cargoLock: cargoLockVersion,
  };
}

/** Extract the [package] version from Cargo.toml text without extra dependencies. */
export function extractCargoPackageVersion(text) {
  const match = /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"\s*$/m.exec(text);
  if (!match) throw new Error("Cargo.toml [package] version missing");
  return match[1];
}

/** Extract the marxen package version from Cargo.lock text without extra dependencies. */
export function extractCargoLockVersion(text) {
  const blocks = text.split("[[package]]");
  for (const block of blocks) {
    if (/^\s*name\s*=\s*"marxen"\s*$/m.test(block)) {
      const match = /^\s*version\s*=\s*"([^"]+)"\s*$/m.exec(block);
      if (!match) throw new Error("Cargo.lock marxen version missing");
      return match[1];
    }
  }
  throw new Error("Cargo.lock marxen package missing");
}

/** Require every version source to equal the tag version exactly. */
export function assertVersionConsistency(version, versions) {
  const entries = [
    ["package.json", versions.packageJson],
    ["package-lock.json version", versions.packageLockRoot],
    ["package-lock.json packages[\"\"]", versions.packageLockTop],
    ["src-tauri/Cargo.toml", versions.cargoToml],
    ["src-tauri/tauri.conf.json", versions.tauriConf],
    ["src-tauri/Cargo.lock", versions.cargoLock],
  ];
  for (const [label, actual] of entries) {
    if (actual !== version) throw new Error(`Version mismatch in ${label}: expected ${version}, got ${actual}`);
  }
}

/** Resolve a version tag to its commit, supporting lightweight and annotated tags. */
export function resolveTagCommit(tag, cwd) {
  parseTag(tag);
  const sha = runCapture("git", ["rev-list", "-n", "1", `refs/tags/${tag}^{commit}`], { cwd });
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Bad tag commit for ${tag}: ${sha}`);
  return sha;
}

/** Resolve the current HEAD commit. */
export function resolveHeadCommit(cwd) {
  const sha = runCapture("git", ["rev-parse", "HEAD"], { cwd });
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Bad HEAD commit: ${sha}`);
  return sha;
}

/** Select the single successful main push Integration run for an exact commit. */
export function selectWorkflowRun(runs, options) {
  const { sha, repo, workflowPath, headBranch, event } = options;
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`SHA must be a 40-char hex commit: ${sha}`);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`Repository must be owner/repo: ${repo}`);
  const candidates = runs.filter(run => (
    run.head_sha === sha
    && run.head_branch === headBranch
    && run.event === event
    && run.status === "completed"
    && run.conclusion === "success"
    && run.path === workflowPath
    && run.repository?.full_name === repo
    && run.head_repository?.full_name === repo
    && Array.isArray(run.pull_requests) && run.pull_requests.length === 0
  ));
  if (candidates.length === 0) throw new Error(`No successful ${workflowPath} main push run for ${sha}`);
  candidates.sort((a, b) => Number(a.id) - Number(b.id));
  return candidates[candidates.length - 1];
}

/** Require a paged list to be complete without hidden pages. */
export function assertCompleteList(total, items, label) {
  if (Number(total) !== items.length) throw new Error(`Incomplete ${label}: total ${total}, got ${items.length}`);
}

/** Require all four native matrix jobs to be completed and successful. */
export function assertJobs(jobs, expectedTargets = RELEASE_EXPECTED_TARGETS) {
  if (!Array.isArray(jobs)) throw new Error("Jobs must be an array");
  if (jobs.length !== expectedTargets.length) {
    throw new Error(`Expected ${expectedTargets.length} native jobs, got ${jobs.length}`);
  }
  for (const job of jobs) {
    if (job.status !== "completed" || job.conclusion !== "success") {
      throw new Error(`Job not successful: ${job.name} ${job.status}/${job.conclusion}`);
    }
  }
  for (const target of expectedTargets) {
    if (!jobs.some(job => typeof job.name === "string" && job.name.includes(target))) {
      throw new Error(`Native job missing for target: ${target}`);
    }
  }
}

/** Require the four named CI artifacts to exist exactly once without expiry. */
export function assertArtifacts(artifacts, expectedNames = RELEASE_EXPECTED_ARTIFACTS) {
  if (!Array.isArray(artifacts)) throw new Error("Artifacts must be an array");
  const names = artifacts.map(item => item.name);
  if (new Set(names).size !== names.length) throw new Error(`Duplicate CI artifacts: ${names.join(",")}`);
  for (const expected of expectedNames) {
    const matches = artifacts.filter(item => item.name === expected);
    if (matches.length !== 1) throw new Error(`CI artifact missing or duplicated: ${expected}`);
  }
  if (artifacts.length !== expectedNames.length) {
    throw new Error(`Unexpected CI artifacts: ${names.join(",")}`);
  }
  for (const artifact of artifacts) {
    if (artifact.expired !== false) throw new Error(`CI artifact expired: ${artifact.name}`);
    if (!(Number(artifact.size_in_bytes) > 0)) throw new Error(`CI artifact empty: ${artifact.name}`);
  }
}

/** Return the exact five installer basenames and owners observed for a version. */
export function expectedReleaseFiles(version) {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Version must be X.Y.Z: ${version}`);
  }
  return [
    { slot: "windows-nsis", basename: `Marxen_${version}_x64-setup.exe`, owner: "marxen-x86_64-pc-windows-msvc" },
    { slot: "linux-deb", basename: `Marxen_${version}_amd64.deb`, owner: "marxen-x86_64-unknown-linux-gnu" },
    { slot: "linux-appimage", basename: `Marxen_${version}_amd64.AppImage`, owner: "marxen-x86_64-unknown-linux-gnu" },
    { slot: "mac-arm64-dmg", basename: `Marxen_${version}_aarch64.dmg`, owner: "marxen-aarch64-apple-darwin" },
    { slot: "mac-x64-dmg", basename: `Marxen_${version}_x64.dmg`, owner: "marxen-x86_64-apple-darwin" },
  ];
}

/** Select the exact five installers, rejecting wrong versions, owners, and escapes. */
export function selectInstallers(files, version) {
  const expected = expectedReleaseFiles(version);
  const byBasename = new Map(expected.map(item => [item.basename, item]));
  if (!Array.isArray(files) || files.length === 0) throw new Error("No artifact files found");
  const found = new Map();
  for (const file of files) {
    if (!file || typeof file.basename !== "string" || typeof file.relativePath !== "string") {
      throw new Error("File entries need basename and relativePath");
    }
    if (file.isSymlink) throw new Error(`Symlink refused: ${file.relativePath}`);
    if (!file.isFile) continue;
    const portable = String(file.relativePath).split("\\").join("/");
    if (portable.startsWith("/") || portable.includes("..")) throw new Error(`Path escape refused: ${file.relativePath}`);
    const wanted = byBasename.get(file.basename);
    if (wanted) {
      if (!portable.startsWith(`${wanted.owner}/`)) throw new Error(`Wrong source artifact for ${file.basename}: ${file.relativePath}`);
      if (!(Number(file.size) > 0)) throw new Error(`Empty installer: ${file.relativePath}`);
      if (found.has(file.basename)) throw new Error(`Duplicate installer basename: ${file.basename}`);
      found.set(file.basename, { slot: wanted.slot, ...file });
      continue;
    }
    const lower = file.basename.toLowerCase();
    const installerLike = lower.endsWith(".exe") || lower.endsWith(".deb") || lower.endsWith(".appimage")
      || lower.endsWith(".dmg") || lower.endsWith(".msi") || lower.endsWith(".pkg")
      || lower.endsWith(".rpm") || lower.endsWith(".snap") || lower.endsWith(".flatpak") || lower.endsWith(".zip");
    if (installerLike) throw new Error(`Unexpected installer for ${version}: ${file.relativePath}`);
  }
  const missing = expected.filter(item => !found.has(item.basename)).map(item => item.basename);
  if (missing.length > 0) throw new Error(`Missing installers for ${version}: ${missing.join(",")}`);
  return expected.map(item => found.get(item.basename));
}

/** Format deterministic SHA256SUMS lines sorted by basename. */
export function formatSha256Sums(pairs) {
  const sorted = [...pairs].sort((a, b) => (a.basename < b.basename ? -1 : a.basename > b.basename ? 1 : 0));
  const seen = new Set();
  let text = "";
  for (const { basename, sha256 } of sorted) {
    if (typeof basename !== "string" || basename.includes("/") || basename.includes("\\") || basename.includes("\n")) {
      throw new Error(`Bad checksum basename: ${basename}`);
    }
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Bad SHA-256 for ${basename}: ${sha256}`);
    if (seen.has(basename)) throw new Error(`Duplicate checksum basename: ${basename}`);
    seen.add(basename);
    text += `${sha256}  ${basename}\n`;
  }
  return text;
}

/** Parse and strictly validate SHA256SUMS contents. */
export function parseSha256Sums(text) {
  const lines = String(text).split("\n").filter(line => line.length > 0);
  const entries = [];
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([^/\s\\]+)$/.exec(line);
    if (!match) throw new Error(`Bad SHA256SUMS line: ${line}`);
    entries.push({ sha256: match[1], basename: match[2] });
  }
  if (new Set(entries.map(entry => entry.basename)).size !== entries.length) {
    throw new Error("Duplicate SHA256SUMS basenames");
  }
  return entries;
}

/** Build concise Japanese release notes without process or agent history. */
export function buildReleaseNotes(input) {
  const { version, tag, sha, runId, assets } = input;
  if (parseTag(tag) !== version) throw new Error(`Tag ${tag} does not match version ${version}`);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Bad source SHA: ${sha}`);
  if (!(Number(runId) > 0)) throw new Error(`Bad Integration run id: ${runId}`);
  const bySlot = Object.fromEntries(assets.map(item => [item.slot, item.basename]));
  for (const slot of ["windows-nsis", "linux-deb", "linux-appimage", "mac-arm64-dmg", "mac-x64-dmg"]) {
    if (!bySlot[slot]) throw new Error(`Release notes missing asset: ${slot}`);
  }
  return [
    `# Marxen ${version}`,
    ``,
    `実 Neovim を文書の正本にする Markdown デスクトップエディターです。ライブプレビューと Vim 操作を既定にし、実 Neovim 0.11.5 の runtime を同梱します。`,
    ``,
    `## 入手`,
    ``,
    `| OS / CPU | ファイル | 形式 |`,
    `| --- | --- | --- |`,
    `| Windows x64 | \`${bySlot["windows-nsis"]}\` | NSIS |`,
    `| Linux x64 | \`${bySlot["linux-deb"]}\` | deb |`,
    `| Linux x64 | \`${bySlot["linux-appimage"]}\` | AppImage |`,
    `| macOS arm64 | \`${bySlot["mac-arm64-dmg"]}\` | DMG |`,
    `| macOS x64 | \`${bySlot["mac-x64-dmg"]}\` | DMG |`,
    ``,
    `SHA256SUMS で検証してください。`,
    ``,
    `## 注意`,
    ``,
    `- 配布は未署名・未公証です。Windows の SmartScreen、macOS の Gatekeeper、Linux の実行権限の警告が出る場合があります。`,
    `- 実 WebView / 日本語 IME と配布後の起動・導入は未検証です。macOS 実機の確認はありません。Chromium や CI ビルドの成功を実機の成功としません。`,
    `- ソースはタグ ${tag}（${sha}）で、Integration CI run ${runId} の成果物だけを使います。`,
    ``,
  ].join("\n");
}

/** Report whether a gh release view failure means the release is absent. */
export function isReleaseNotFound(stderr) {
  return /release not found|not found.*404|\b404\b/i.test(String(stderr ?? ""));
}

/** Decide draft creation, failing closed on any existing release or draft. */
export function decideReleaseAction(existing, input) {
  const { tag } = input;
  parseTag(tag);
  if (!existing) return "create";
  if (existing.tagName !== tag) throw new Error(`Existing release tag mismatch: ${existing.tagName}`);
  throw new Error(`Release already exists for ${tag}, refusing automatic recovery`);
}

/** Extract the hex digest from a strict sha256:64hex release asset digest field. */
export function assetDigestHex(digest) {
  const match = /^sha256:([0-9a-f]{64})$/i.exec(String(digest ?? ""));
  if (!match) throw new Error(`Bad asset digest: ${String(digest ?? "")}`);
  return match[1].toLowerCase();
}

/** Require draft assets to match local files in name, size, and SHA-256. */
export function assertDraftAssets(draft, locals, input) {
  const { tag, sha } = input;
  parseTag(tag);
  if (!draft || draft.tagName !== tag) throw new Error(`Draft tag mismatch: ${draft?.tagName}`);
  if (!draft.isDraft) throw new Error(`Release already published: ${tag}`);
  if (draft.isPrerelease) throw new Error(`Draft is prerelease: ${tag}`);
  if (sha && /^[0-9a-f]{40}$/i.test(String(draft.targetCommitish ?? "")) && String(draft.targetCommitish).toLowerCase() !== String(sha).toLowerCase()) {
    throw new Error(`Draft source mismatch: ${draft.targetCommitish}`);
  }
  const remote = Array.isArray(draft.assets) ? draft.assets : [];
  if (remote.length !== locals.length) throw new Error(`Draft asset count mismatch: ${remote.length} vs ${locals.length}`);
  const remoteNames = remote.map(asset => asset.name);
  if (new Set(remoteNames).size !== remoteNames.length) throw new Error(`Duplicate draft assets: ${remoteNames.join(",")}`);
  const byName = new Map(locals.map(item => [item.basename, item]));
  if (byName.size !== locals.length) throw new Error("Duplicate local basenames");
  for (const asset of remote) {
    const local = byName.get(asset.name);
    if (!local) throw new Error(`Unexpected draft asset: ${asset.name}`);
    if (asset.state !== "uploaded") throw new Error(`Draft asset not uploaded: ${asset.name}`);
    if (Number(asset.size) !== Number(local.size)) throw new Error(`Draft asset size mismatch: ${asset.name}`);
    if (assetDigestHex(asset.digest) !== String(local.sha256).toLowerCase()) {
      throw new Error(`Draft asset hash mismatch: ${asset.name}`);
    }
  }
}

/** Collect the six publish files and hashes from an assembled directory. */
export function collectVerifyLocals(dist) {
  const sumsText = readFileSync(join(dist, "SHA256SUMS"), "utf8");
  const entries = parseSha256Sums(sumsText);
  if (entries.length !== 5) throw new Error(`SHA256SUMS must list 5 installers, got ${entries.length}`);
  const locals = entries.map(entry => {
    const data = readBinarySync(join(dist, entry.basename));
    const actual = createHash("sha256").update(data).digest("hex");
    if (actual !== entry.sha256) throw new Error(`Local hash mismatch: ${entry.basename}`);
    return { basename: entry.basename, sha256: actual, size: data.length };
  });
  const manifest = readBinarySync(join(dist, "SHA256SUMS"));
  locals.push({ basename: "SHA256SUMS", sha256: createHash("sha256").update(manifest).digest("hex"), size: manifest.length });
  return locals;
}

/** Read one --name value from exact argv without shell interpolation. */
export function cliArg(argv, name) {
  const flag = `--${name}`;
  const index = argv.indexOf(flag);
  if (index < 0 || index + 1 >= argv.length) throw new Error(`Missing ${flag} <value>`);
  if (argv.indexOf(flag, index + 1) >= 0) throw new Error(`Duplicate ${flag}`);
  return argv[index + 1];
}

/** Run one command with exact argv and return trimmed stdout without logging secrets. */
export function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr ?? ""}`);
  return String(result.stdout ?? "").trim();
}

/** Build exact gh api argv for reads, forcing GET so -f stays a query string. */
export function ghApiArgs(path, fields) {
  const args = ["api", "--method", "GET", path];
  for (const [key, value] of fields) args.push("-f", `${key}=${value}`);
  return args;
}

/** Call the GitHub REST API for reads with an explicit GET method. */
export function ghApiGet(path, fields, options = {}) {
  return runCapture("gh", ghApiArgs(path, fields), options);
}

/** Collect regular files under a directory while marking symlinks for refusal. */
export function collectArtifactFiles(root) {
  const entries = [];
  /** Walk one directory without following symlinks. */
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = relative(root, full).split("\\").join("/");
      const detailed = lstatSync(full);
      if (detailed.isSymbolicLink()) {
        entries.push({ basename: entry.name, relativePath: rel, fullPath: full, size: 0, isFile: false, isSymlink: true });
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile()) {
        entries.push({ basename: entry.name, relativePath: rel, fullPath: full, size: Number(detailed.size), isFile: true, isSymlink: false });
      }
    }
  }
  walk(root);
  return entries;
}

/** Compute lowercase SHA-256 hex for one file using Node builtins. */
export function sha256File(path) {
  return createHash("sha256").update(readBinarySync(path)).digest("hex");
}

import { appendFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

/** Run tag, version, release-absence, and CI checks, returning the validated source. */
export function runValidate(argv, env, deps = {}) {
  const tag = cliArg(argv, "tag");
  const repo = cliArg(argv, "repo");
  let root = deps.root ?? resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
  if (argv.includes("--root")) root = resolvePath(cliArg(argv, "root"));
  if (argv.some(item => item.startsWith("--") && !["--tag", "--repo", "--root"].includes(item))) {
    throw new Error(`Unknown argument in ${argv.join(" ")}`);
  }
  const version = parseTag(tag);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`Repository must be owner/repo: ${repo}`);
  const tagSha = resolveTagCommit(tag, root);
  const headSha = resolveHeadCommit(root);
  if (tagSha !== headSha) throw new Error(`Tag ${tag} (${tagSha}) does not match HEAD (${headSha})`);
  assertVersionConsistency(version, readVersionFiles(root));
  const viewed = deps.viewRelease ? deps.viewRelease(tag, root) : defaultViewRelease(tag, root);
  if (viewed.status === 0) {
    decideReleaseAction(JSON.parse(String(viewed.stdout)), { tag });
  } else if (!isReleaseNotFound(viewed.stderr)) {
    throw new Error(`gh release view failed (${viewed.status}): ${viewed.stderr ?? ""}`);
  }
  const ghGet = deps.ghGet ?? ((path, fields) => ghApiGet(path, fields, { cwd: root }));
  const runsJson = JSON.parse(ghGet(`repos/${repo}/actions/workflows/ci.yml/runs`, [
    ["head_sha", tagSha],
    ["branch", "main"],
    ["event", "push"],
    ["status", "completed"],
    ["per_page", "20"],
  ]));
  assertCompleteList(runsJson.total_count, runsJson.workflow_runs ?? [], "workflow runs");
  const run = selectWorkflowRun(runsJson.workflow_runs ?? [], {
    sha: tagSha,
    repo,
    workflowPath: RELEASE_WORKFLOW_PATH,
    headBranch: RELEASE_HEAD_BRANCH,
    event: RELEASE_HEAD_EVENT,
  });
  if (run.name !== RELEASE_WORKFLOW_NAME) throw new Error(`Workflow must be ${RELEASE_WORKFLOW_NAME}, got ${run.name}`);
  const jobsJson = JSON.parse(ghGet(`repos/${repo}/actions/runs/${run.id}/jobs`, [["per_page", "100"]]));
  assertCompleteList(jobsJson.total_count, jobsJson.jobs ?? [], "jobs");
  assertJobs(jobsJson.jobs ?? []);
  const artifactsJson = JSON.parse(ghGet(`repos/${repo}/actions/runs/${run.id}/artifacts`, [["per_page", "100"]]));
  assertCompleteList(artifactsJson.total_count, artifactsJson.artifacts ?? [], "artifacts");
  assertArtifacts(artifactsJson.artifacts ?? []);
  const output = env?.GITHUB_OUTPUT;
  if (output) {
    appendFileSync(output, `run-id=${run.id}\n`);
    appendFileSync(output, `version=${version}\n`);
    appendFileSync(output, `sha=${tagSha}\n`);
  }
  return { runId: run.id, version, sha: tagSha };
}

/** View one release without conflating missing releases with other failures. */
export function defaultViewRelease(tag, cwd) {
  const result = spawnSync("gh", ["release", "view", tag, "--json", "tagName,isDraft,isPrerelease"], { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}
