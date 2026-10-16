import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { assertDraftAssets, cliArg, collectVerifyLocals, parseTag } from "./release-common.mjs";

const argv = process.argv.slice(2);
const dist = resolve(cliArg(argv, "dist"));
const tag = cliArg(argv, "tag");
const sha = cliArg(argv, "sha");
if (argv.some(item => item.startsWith("--") && !["--dist", "--tag", "--sha"].includes(item))) {
  throw new Error(`Unknown argument in ${argv.join(" ")}`);
}
parseTag(tag);
if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`SHA must be 40-char hex: ${sha}`);

const viewed = spawnSync("gh", ["release", "view", tag, "--json", "tagName,isDraft,isPrerelease,targetCommitish,assets"], { encoding: "utf8" });
if (viewed.error) throw viewed.error;
if (viewed.status !== 0) throw new Error(`gh release view failed (${viewed.status}): ${viewed.stderr ?? ""}`);
assertDraftAssets(JSON.parse(String(viewed.stdout)), collectVerifyLocals(dist), { tag, sha });
console.log(`Draft ${tag} has 6 uploaded assets matching local files.`);
