/** Shared pure validators for the version-tag release workflow. */
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

/** Require a completed successful run object to match the exact tag source. */
export function assertWorkflowRun(run, options) {
  const selected = selectWorkflowRun([run], options);
  if (Number(selected.id) !== Number(run.id)) throw new Error("Workflow run failed exact-source validation");
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

/** Classify installer candidates while rejecting symlinks and path escapes. */
export function selectInstallers(files, version) {
  if (typeof version !== "string" || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Version must be X.Y.Z: ${version}`);
  }
  if (!Array.isArray(files) || files.length === 0) throw new Error("No artifact files found");
  const seenBasenames = new Set();
  const candidates = [];
  for (const file of files) {
    if (!file || typeof file.basename !== "string" || typeof file.relativePath !== "string") {
      throw new Error("File entries need basename and relativePath");
    }
    if (file.isSymlink) throw new Error(`Symlink refused: ${file.relativePath}`);
    if (!file.isFile) continue;
    const portable = String(file.relativePath).split("\\").join("/");
    if (portable.startsWith("/") || portable.includes("..")) throw new Error(`Path escape refused: ${file.relativePath}`);
    const lower = file.basename.toLowerCase();
    const isExe = lower.endsWith(".exe");
    const isDeb = lower.endsWith(".deb");
    const isAppImage = lower.endsWith(".appimage");
    const isDmg = lower.endsWith(".dmg");
    const isUnexpectedInstaller = !isExe && !isDeb && !isAppImage && !isDmg
      && (lower.endsWith(".msi") || lower.endsWith(".pkg") || lower.endsWith(".rpm")
        || lower.endsWith(".snap") || lower.endsWith(".flatpak") || lower.endsWith(".zip"));
    if (isUnexpectedInstaller) throw new Error(`Unexpected installer: ${file.relativePath}`);
    if (!isExe && !isDeb && !isAppImage && !isDmg) continue;
    if (!(Number(file.size) > 0)) throw new Error(`Empty installer: ${file.relativePath}`);
    const folded = file.basename.toLowerCase();
    if (seenBasenames.has(folded)) throw new Error(`Duplicate installer basename: ${file.basename}`);
    seenBasenames.add(folded);
    if (!file.basename.includes(version)) throw new Error(`Installer missing version ${version}: ${file.basename}`);
    candidates.push(file);
  }
  const exe = candidates.filter(file => file.basename.toLowerCase().endsWith(".exe"));
  const deb = candidates.filter(file => file.basename.toLowerCase().endsWith(".deb"));
  const appimage = candidates.filter(file => file.basename.toLowerCase().endsWith(".appimage"));
  const dmg = candidates.filter(file => file.basename.toLowerCase().endsWith(".dmg"));
  if (exe.length !== 1) throw new Error(`Expected exactly 1 NSIS exe, got ${exe.length}`);
  if (deb.length !== 1) throw new Error(`Expected exactly 1 deb, got ${deb.length}`);
  if (appimage.length !== 1) throw new Error(`Expected exactly 1 AppImage, got ${appimage.length}`);
  if (dmg.length !== 2) throw new Error(`Expected exactly 2 dmg files, got ${dmg.length}`);
  if (candidates.length !== 5) throw new Error(`Expected exactly 5 installers, got ${candidates.length}`);
  assertWindowsInstaller(exe[0]);
  assertLinuxInstaller(deb[0], "deb");
  assertLinuxInstaller(appimage[0], "AppImage");
  const arm = dmg.filter(file => /(aarch64|arm64)/i.test(file.basename));
  const intel = dmg.filter(file => /(x64|x86_64)/i.test(file.basename) && !/(aarch64|arm64)/i.test(file.basename));
  if (arm.length !== 1 || intel.length !== 1) throw new Error(`DMG arch split ambiguous: ${dmg.map(file => file.basename).join(",")}`);
  return [
    { slot: "windows-nsis", ...exe[0] },
    { slot: "linux-deb", ...deb[0] },
    { slot: "linux-appimage", ...appimage[0] },
    { slot: "mac-arm64-dmg", ...arm[0] },
    { slot: "mac-x64-dmg", ...intel[0] },
  ];
}

/** Require a Windows NSIS exe to carry its versioned x64 setup name. */
export function assertWindowsInstaller(file) {
  if (!/-setup\.exe$/i.test(file.basename)) throw new Error(`NSIS exe must end with -setup.exe: ${file.basename}`);
  if (!/(x64|x86_64)/i.test(file.basename)) throw new Error(`NSIS exe missing x64 arch: ${file.basename}`);
}

/** Require a Linux package to carry its versioned x64 arch name. */
export function assertLinuxInstaller(file, kind) {
  if (!/(amd64|x64|x86_64)/i.test(file.basename)) throw new Error(`Linux ${kind} missing x64 arch: ${file.basename}`);
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

/** Decide draft creation or guarded recovery without touching published releases. */
export function decideReleaseAction(existing, input) {
  const { tag } = input;
  parseTag(tag);
  if (!existing) return "create";
  if (existing.tagName !== tag) throw new Error(`Existing release tag mismatch: ${existing.tagName}`);
  if (!existing.isDraft) throw new Error(`Release already published, refusing to overwrite: ${tag}`);
  if (existing.isPrerelease) throw new Error(`Existing draft is prerelease, refusing: ${tag}`);
  return "recreate-draft";
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
