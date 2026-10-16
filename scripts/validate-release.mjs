import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_HEAD_BRANCH,
  RELEASE_HEAD_EVENT,
  RELEASE_WORKFLOW_NAME,
  RELEASE_WORKFLOW_PATH,
  assertArtifacts,
  assertJobs,
  assertVersionConsistency,
  cliArg,
  parseTag,
  readVersionFiles,
  runCapture,
  selectWorkflowRun,
} from "./release-common.mjs";

const argv = process.argv.slice(2);
const tag = cliArg(argv, "tag");
const repo = cliArg(argv, "repo");
let root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (argv.includes("--root")) root = resolve(cliArg(argv, "root"));
if (argv.some(item => item.startsWith("--") && !["--tag", "--repo", "--root"].includes(item))) {
  throw new Error(`Unknown argument in ${argv.join(" ")}`);
}

const version = parseTag(tag);
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`Repository must be owner/repo: ${repo}`);
runCapture("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`], { cwd: root });
const tagSha = runCapture("git", ["rev-list", "-n", "1", "--", tag], { cwd: root });
const headSha = runCapture("git", ["rev-parse", "HEAD"], { cwd: root });
if (!/^[0-9a-f]{40}$/.test(tagSha) || !/^[0-9a-f]{40}$/.test(headSha)) throw new Error("Git SHA must be 40-char hex");
if (tagSha !== headSha) throw new Error(`Tag ${tag} (${tagSha}) does not match HEAD (${headSha})`);

const versions = readVersionFiles(root);
assertVersionConsistency(version, versions);

const runsText = runCapture("gh", [
  "api",
  `repos/${repo}/actions/workflows/ci.yml/runs`,
  "-f",
  `head_sha=${tagSha}`,
  "-f",
  "branch=main",
  "-f",
  "event=push",
  "-f",
  "status=completed",
  "-f",
  "per_page=20",
], { cwd: root });
const runs = JSON.parse(runsText).workflow_runs ?? [];
const run = selectWorkflowRun(runs, {
  sha: tagSha,
  repo,
  workflowPath: RELEASE_WORKFLOW_PATH,
  headBranch: RELEASE_HEAD_BRANCH,
  event: RELEASE_HEAD_EVENT,
});
if (run.name !== RELEASE_WORKFLOW_NAME) throw new Error(`Workflow must be ${RELEASE_WORKFLOW_NAME}, got ${run.name}`);

const jobsText = runCapture("gh", [
  "api",
  `repos/${repo}/actions/runs/${run.id}/jobs`,
  "--paginate",
  "-f",
  "per_page=100",
], { cwd: root });
assertJobs(JSON.parse(jobsText).jobs ?? []);

const artifactsText = runCapture("gh", [
  "api",
  `repos/${repo}/actions/runs/${run.id}/artifacts`,
  "--paginate",
  "-f",
  "per_page=100",
], { cwd: root });
assertArtifacts(JSON.parse(artifactsText).artifacts ?? []);

const output = process.env.GITHUB_OUTPUT;
if (output) {
  appendFileSync(output, `run-id=${run.id}\n`);
  appendFileSync(output, `version=${version}\n`);
  appendFileSync(output, `sha=${tagSha}\n`);
} else {
  console.log(JSON.stringify({ runId: run.id, version, sha: tagSha }));
}
console.log(`Validated ${tag} at ${tagSha} with Integration run ${run.id}.`);
