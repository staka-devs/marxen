import { describe, expect, it } from "vitest";
import { japaneseTranslator, renderLocalizedText } from "../../domain/localization";
import {
  approveAndSaveStagedCopy,
  retryFailedImports,
  reviewPorts,
  summarizeSavedResult,
} from "./staging-service";
import type { ApproveResult } from "../../contracts/isolation-contracts";

describe("saved result summary", () => {
  it("reports actual saved files after apply-and-save", () => {
    const summary = summarizeSavedResult([
      { documentId: "doc_a", saved: true },
      { documentId: "doc_b", saved: true },
    ]);
    expect(summary.savedCount).toBe(2);
    expect(summary.failedCount).toBe(0);
    expect(renderLocalizedText(summary.status, japaneseTranslator)).toContain("2");
  });

  it("reports failed files instead of claiming full success", () => {
    const summary = summarizeSavedResult([
      { documentId: "doc_a", saved: true },
      { documentId: "doc_b", saved: false, error: "disk changed" },
    ]);
    expect(summary.savedCount).toBe(1);
    expect(summary.failedCount).toBe(1);
    expect(renderLocalizedText(summary.status, japaneseTranslator)).toContain("1");
    expect(renderLocalizedText(summary.notice, japaneseTranslator)).toContain("1");
  });
});

/** Applied approval outcome fixture for orchestration assertions. */
function appliedOutcome(documentId: string, revision: number) {
  return { documentId, applied: true, revision, error: null, rolledBack: false, rollbackError: null };
}

/** Unchanged approval outcome fixture for orchestration assertions. */
function unchangedOutcome(documentId: string, revision: number) {
  return { documentId, applied: false, revision, error: null, rolledBack: false, rollbackError: null };
}

/** Snapshot fixture at an exact revision for orchestration assertions. */
function snapshot(documentId: string, revision: number, text: string) {
  return { documentId, revision, text, dirty: true };
}

/** Open-document fixture returned by fake Markdown creation. */
function openedDocument(path: string, documentId: string, text: string) {
  return { path, snapshot: snapshot(documentId, 0, text) };
}

describe("approve and save orchestration", () => {
  it("saves the exact approved revision so interleaved edits fail stale", async () => {
    const seen: number[] = [];
    let liveRevision = 4;
    const ports = reviewPorts(
      async (copyId) => ({
        copyId,
        outcomes: [appliedOutcome("doc_a", 4)],
      } satisfies ApproveResult),
      async (documentId) => snapshot(documentId, liveRevision, "applied text"),
      async (request) => {
        seen.push(request.baseRevision);
        // A user edit interleaved after application: only the approved
        // revision may save, anything else fails without touching text.
        if (request.baseRevision !== liveRevision) throw new Error("stale revision");
        return { documentId: request.documentId, revision: liveRevision, dirty: false };
      },
      async () => { throw new Error("unexpected import"); },
    );
    const calm = await approveAndSaveStagedCopy(ports, "copy_1", []);
    expect(calm.saved).toEqual([{ documentId: "doc_a", saved: true }]);
    liveRevision = 5;
    const conflicted = await approveAndSaveStagedCopy(
      reviewPorts(
        async (copyId) => ({ copyId, outcomes: [appliedOutcome("doc_a", 4)] }),
        async (documentId) => snapshot(documentId, 5, "user edit"),
        async (request) => {
          seen.push(request.baseRevision);
          if (request.baseRevision !== liveRevision) throw new Error("stale revision");
          return { documentId: request.documentId, revision: liveRevision, dirty: false };
        },
        async () => { throw new Error("unexpected import"); },
      ),
      "copy_1",
      [],
    );
    expect(seen).toEqual([4, 4]);
    expect(conflicted.saved).toEqual([
      { documentId: "doc_a", saved: false, error: "stale revision" },
    ]);
  });

  it("records snapshot-fetch failures without attempting a save", async () => {
    const saved: string[] = [];
    const ports = reviewPorts(
      async (copyId) => ({ copyId, outcomes: [appliedOutcome("doc_a", 4)] }),
      async () => { throw new Error("snapshot gone"); },
      async (request) => {
        saved.push(request.documentId);
        return { documentId: request.documentId, revision: 4, dirty: false };
      },
      async () => { throw new Error("unexpected import"); },
    );
    const result = await approveAndSaveStagedCopy(ports, "copy_1", []);
    expect(result.snapshots).toEqual([]);
    expect(result.saved).toEqual([{ documentId: "doc_a", saved: false, error: "snapshot gone" }]);
    expect(saved).toEqual([]);
  });

  it("keeps partial save failures per document without hiding them", async () => {
    const ports = reviewPorts(
      async (copyId) => ({
        copyId,
        outcomes: [appliedOutcome("doc_a", 4), appliedOutcome("doc_b", 2)],
      }),
      async (documentId) => snapshot(documentId, 0, "text"),
      async (request) => {
        if (request.documentId === "doc_b") throw new Error("disk changed");
        return { documentId: request.documentId, revision: 0, dirty: false };
      },
      async () => { throw new Error("unexpected import"); },
    );
    const result = await approveAndSaveStagedCopy(ports, "copy_1", []);
    expect(result.saved).toEqual([
      { documentId: "doc_a", saved: true },
      { documentId: "doc_b", saved: false, error: "disk changed" },
    ]);
  });

  it("reports new-only import failures without claiming success", async () => {
    const ports = reviewPorts(
      async (copyId) => ({ copyId, outcomes: [unchangedOutcome("doc_a", 4)] }),
      async (documentId) => snapshot(documentId, 4, "text"),
      async (request) => ({ documentId: request.documentId, revision: 4, dirty: false }),
      async () => { throw new Error("already exists: note.md"); },
    );
    const result = await approveAndSaveStagedCopy(ports, "copy_1", [
      { rel: "note.md", content: "# Note\n" },
    ]);
    expect(result.saved).toEqual([]);
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]).toMatchObject({ rel: "note.md", ok: false });
    expect(result.imports[0].error).toContain("already exists");
    expect(result.imports[0].content).toBe("# Note\n");
  });

  it("preserves existing files when creation rejects duplicates", async () => {
    const store = new Map<string, string>([["note.md", "# Original\n"]]);
    const created: string[] = [];
    const ports = reviewPorts(
      async (copyId) => ({ copyId, outcomes: [unchangedOutcome("doc_a", 4)] }),
      async (documentId) => snapshot(documentId, 4, "text"),
      async (request) => ({ documentId: request.documentId, revision: 4, dirty: false }),
      async (path, text) => {
        if (store.has(path)) throw new Error(`already exists: ${path}`);
        store.set(path, text ?? "");
        created.push(path);
        return openedDocument(path, `doc_${path}`, text ?? "");
      },
    );
    const result = await approveAndSaveStagedCopy(ports, "copy_1", [
      { rel: "note.md", content: "# Agent\n" },
      { rel: "fresh.md", content: "# Fresh\n" },
    ]);
    expect(store.get("note.md")).toBe("# Original\n");
    expect(created).toEqual(["fresh.md"]);
    expect(result.imports.map((item) => [item.rel, item.ok])).toEqual([
      ["note.md", false],
      ["fresh.md", true],
    ]);
    expect(result.imports[1].opened).toMatchObject({ path: "fresh.md" });
  });

  it("retries only failed imports without reapplying edits", async () => {
    const calls: string[] = [];
    const store = new Map<string, string>();
    const ports = reviewPorts(
      async () => { calls.push("approve"); throw new Error("must not reapply"); },
      async () => { calls.push("snapshot"); throw new Error("must not refetch"); },
      async () => { calls.push("save"); throw new Error("must not resave"); },
      async (path, text) => {
        calls.push(`create:${path}`);
        if (path === "blocked.md" && !store.has("unblocked")) throw new Error("duplicate");
        store.set(path, text ?? "");
        return openedDocument(path, `doc_${path}`, text ?? "");
      },
    );
    const failed = [{ rel: "blocked.md", content: "# Blocked\n" }];
    expect(await retryFailedImports(ports, failed)).toMatchObject([{ rel: "blocked.md", ok: false }]);
    store.set("unblocked", "yes");
    const retried = await retryFailedImports(ports, failed);
    expect(retried).toMatchObject([{ rel: "blocked.md", ok: true }]);
    expect(calls).not.toContain("approve");
    expect(calls).not.toContain("snapshot");
    expect(calls).not.toContain("save");
  });
});
