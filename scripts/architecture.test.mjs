import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import ts from "typescript";
import { inspectRust, inspectTypeScript, layerOf } from "./architecture-check.mjs";

/** Create real source files for module/global resolution and clean up only this owned fixture. */
function withSourceFixture(source, action) {
  const temporaryRoot = resolve(tmpdir());
  const root = mkdtempSync(join(temporaryRoot, "marxen-architecture-"));
  try {
    mkdirSync(join(root, "src/application"), { recursive: true });
    mkdirSync(join(root, "src/infrastructure"), { recursive: true });
    writeFileSync(join(root, "src/application/example.ts"), source);
    writeFileSync(join(root, "src/infrastructure/adapter.ts"), "export const value = 1;");
    return action(root);
  } finally {
    if (!resolve(root).startsWith(temporaryRoot + sep) || !basename(root).startsWith("marxen-architecture-")) throw new Error("Fixture cleanup path escaped its owned temporary root");
    rmSync(root, { recursive: true, force: true });
  }
}

test("documentation covers private functions, constructors, callable properties and trait methods", () => {
  const ts = inspectTypeScript("src/presentation/example.ts", `
    /** Prepare the editor without changing its authoritative revision. */
    const prepare = () => 1;
    class Editor {
      /** Bind the already-created editor ports. */
      constructor() {}
      /** Return the selected document identifier. */
      private current() { return 1; }
    }
    interface Port {
      /** Stop the owned request and preserve its snapshot. */
      stop(): void;
      /** Reload the newest authoritative document snapshot. */
      load: () => Promise<void>;
    }
  `);
  assert.equal(ts.methods, 5);
  assert.equal(ts.documented, 5);
  assert.deepEqual(ts.issues, []);
  const rust = inspectRust("src-tauri/src/application/example.rs", `
    trait Port {
      /// Return the authoritative snapshot without mutating it.
      fn snapshot(&self);
    }
    /// Build a document with its supplied ports.
    #[cfg(feature = "desktop")]
    pub(crate) async fn open() {}
  `);
  assert.equal(rust.methods, 2);
  assert.equal(rust.documented, 2);
  assert.deepEqual(rust.issues, []);
});

test("named local helpers need docs while anonymous callbacks do not", () => {
  const result = inspectTypeScript("src/application/example.ts", `
    /** Execute the action using its original revision. */
    function run() {
      const hidden = () => 1;
      [1].map(value => value + 1);
    }
  `);
  assert.equal(result.methods, 2);
  assert.equal(result.documented, 1);
  assert.match(result.issues[0].detail, /hidden/);
});

test("array transforms remain anonymous callbacks while callable wrappers need docs", () => {
  const result = inspectTypeScript("src/presentation/example.ts", `
    const selected = [1].filter(value => value > 0);
    const rows = [1].flatMap(value => [value]);
    const handler = useCallback(() => 1, []);
  `);
  assert.equal(result.methods, 1);
  assert.match(result.issues[0].detail, /handler/);
});

test("ordinary comments and placeholder documentation do not satisfy the requirement", () => {
  const ts = inspectTypeScript("src/application/example.ts", "// This is ordinary prose.\nfunction missing() {}\n/** TODO */\nconst pending = () => 1;");
  assert.equal(ts.documented, 0);
  const rust = inspectRust("src-tauri/src/domain/example.rs", "// Ordinary comment.\nfn missing() {}\n/// TODO\nfn pending() {}");
  assert.equal(rust.documented, 0);
});

test("Rust raw strings, lifetimes, chars and nested comments do not create fake operations", () => {
  const result = inspectRust("src-tauri/src/domain/example.rs", `
    const LUA: &str = r###"fn fake() {} crate::infrastructure::bad();"###;
    const QUOTE: char = '\\'';
    /* fn fake() {} /* nested */ */
    /// Return the same borrowed identifier.
    fn identity<'a>(id: &'a str) -> &'a str { id }
  `);
  assert.equal(result.methods, 1);
  assert.equal(result.documented, 1);
  assert.deepEqual(result.issues, []);
});

test("Unicode and raw Rust function names retain the same documentation requirement", () => {
  const result = inspectRust("src-tauri/src/domain/example.rs", "/// Preserve the supplied range unchanged.\nfn 範囲を保つ() {}\nfn r#type() {}");
  assert.equal(result.methods, 2);
  assert.equal(result.documented, 1);
  assert.match(result.issues[0].detail, /r#type/);
});

test("test-only Rust effects are exempt but helpers still need docs and production remains checked", () => {
  const result = inspectRust("src-tauri/src/application/example.rs", `
    #[cfg(test)]
    mod tests {
      use std::fs;
      use crate::infrastructure::storage;
      fn helper() {}
    }
    #[cfg(not(test))]
    use std::fs;
    #[cfg(any(test, feature = "desktop"))]
    use std::process;
  `);
  assert.equal(result.methods, 1);
  assert.equal(result.documented, 0);
  assert.equal(result.issues.filter(issue => issue.rule === "effect").length, 2);
  assert.equal(result.issues.filter(issue => issue.rule === "dependency").length, 0);
});

test("grouped and aliased Rust imports cannot hide outward dependencies", () => {
  const result = inspectRust("src-tauri/src/domain/example.rs", "use crate::{contracts::DocumentId, infrastructure::{storage as persistence}, presentation::ipc};");
  const edges = result.issues.filter(issue => issue.rule === "dependency");
  assert.equal(edges.length, 2);
  assert.ok(edges.some(issue => issue.detail.includes("infrastructure")));
  assert.ok(edges.some(issue => issue.detail.includes("presentation")));
});

test("application cannot call effectful modules or use old composition aliases", () => {
  const result = inspectRust("src-tauri/src/application/example.rs", "use reqwest as transport; use std::fs; use crate::storage; crate::infrastructure::storage::read();");
  assert.ok(result.issues.some(issue => issue.rule === "effect" && issue.detail.includes("reqwest")));
  assert.ok(result.issues.some(issue => issue.rule === "effect" && issue.detail.includes("std::fs")));
  assert.ok(result.issues.some(issue => issue.detail.includes("unclassified")));
  assert.ok(result.issues.some(issue => issue.detail.includes("infrastructure")));
});

test("platform effects are allowed in infrastructure but sibling presentation imports are rejected", () => {
  const result = inspectRust("src-tauri/src/infrastructure/storage.rs", "use std::fs; use crate::application::ports::Store; use crate::presentation::ipc;");
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0].detail, /presentation/);
});

test("TypeScript effect imports and generated contracts are distinguished", () => {
  const result = inspectTypeScript("src/domain/example.ts", 'import { invoke } from "@tauri-apps/api/core";');
  assert.ok(result.issues.some(issue => issue.rule === "effect"));
  const generated = inspectTypeScript("src/contracts/contract.ts", "// Generated from src-tauri/src/contracts/mod.rs.\nexport type Handler = () => void;");
  assert.equal(generated.methods, 0);
});

test("inner TypeScript layers cannot import native filesystem or subprocess effects", () => {
  const source = 'import fs from "node:fs/promises"; import { spawn } from "child_process";';
  const inner = inspectTypeScript("src/application/example.ts", source);
  assert.equal(inner.issues.filter(issue => issue.rule === "effect").length, 2);
  assert.deepEqual(inspectTypeScript("src/infrastructure/example.ts", source).issues, []);
});

test("Windows and POSIX paths identify the same five layers", () => {
  assert.equal(layerOf("src\\application\\document.ts"), "application");
  assert.equal(layerOf("src-tauri/src/infrastructure/storage.rs"), "infrastructure");
  assert.equal(layerOf("src/main.tsx"), null);
});

test("type-only, dynamic and re-export imports cannot conceal infrastructure dependencies", () => {
  const source = `
    export type Adapter = typeof import("../infrastructure/adapter");
    export { value } from "../infrastructure/adapter";
    import("../infrastructure/adapter");
  `;
  withSourceFixture(source, root => {
    const result = inspectTypeScript("src/application/example.ts", source, { root });
    assert.equal(result.issues.filter(issue => issue.rule === "dependency").length, 3);
  });
});

test("browser globals are rejected while locally named document values remain valid", () => {
  const source = `
    const element = document.createElement("div");
    /** Read the supplied snapshot identifier without accessing the browser. */
    const identifier = (document: { id: string }) => document.id;
  `;
  withSourceFixture(source, root => {
    const file = join(root, "src/application/example.ts");
    const program = ts.createProgram([file], { noEmit: true });
    const result = inspectTypeScript("src/application/example.ts", source, { root, checker: program.getTypeChecker(), sourceFile: program.getSourceFile(file) });
    assert.equal(result.issues.filter(issue => issue.rule === "effect").length, 1);
    assert.equal(result.documented, 1);
  });
});

test("browser HTTP calls are detected without rejecting an injected transport named fetch", () => {
  const source = `
    fetch("https://example.test");
    /** Request data through the supplied application transport. */
    function load(fetch: (path: string) => Promise<string>) { return fetch("a.md"); }
  `;
  withSourceFixture(source, root => {
    const file = join(root, "src/application/example.ts");
    const program = ts.createProgram([file], { noEmit: true });
    const result = inspectTypeScript("src/application/example.ts", source, { root, checker: program.getTypeChecker(), sourceFile: program.getSourceFile(file) });
    assert.equal(result.issues.filter(issue => issue.rule === "effect").length, 1);
    assert.equal(result.documented, 1);
  });
});
