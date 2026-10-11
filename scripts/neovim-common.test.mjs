import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertSha256, hostTarget, manifest, removeChild, requestedTarget } from "./neovim-common.mjs";

test("all four native targets resolve and unsupported hosts fail closed", () => {
  for (const [platform, arch] of [["win32", "x64"], ["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"]]) assert.ok(manifest.targets[hostTarget(platform, arch)]);
  assert.throws(() => hostTarget("linux", "arm64"));
  assert.throws(() => requestedTarget(["--target", "../../outside"]));
});

test("corrupt archive is rejected before extraction", () => {
  const bytes = Buffer.from("archive");
  assertSha256(bytes, createHash("sha256").update(bytes).digest("hex"));
  assert.throws(() => assertSha256(Buffer.from("corrupt"), createHash("sha256").update(bytes).digest("hex")), /mismatch/);
});

test("recursive cleanup refuses parent and paths outside cache", async () => {
  await assert.rejects(removeChild(".cache", ".cache"), /Refusing/);
  await assert.rejects(removeChild(".cache", "../outside"), /Refusing/);
});
