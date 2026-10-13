import { describe, expect, it } from "vitest";
import { japaneseTranslator, renderLocalizedText } from "../../domain/localization";
import {
  approveAndSaveStagedCopy,
  importStagedFiles,
  reviewPorts,
  summarizeSavedResult,
  type ImportPorts,
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

/** Snapshot fixture at an exact revision for orchestration assertions. */
function snapshot(documentId: string, revision: number, text: string) {
  return { documentId, revision, text, dirty: true };
}

describe("approve and save orchestration", () => {
  it("saves the exact approved revision so interleaved edits fail stale", async () => {
    const seen: number[] = [];
    let liveRevision = 4;
    /** Fake approval returning the programmed applied outcome. */
    const approveCopy = async (copyId: string) => ({
      copyId,
      outcomes: [appliedOutcome("doc_a", 4)],
    } satisfies ApproveResult);
    /** Fake snapshot reader tracking the live revision. */
    const fetchSnapshot = async (documentId: string) => snapshot(documentId, liveRevision, "applied text");
    /** Fake save rejecting anything but the live revision. */
    const saveDocument = async (request: { documentId: string; baseRevision: number }) => {
      seen.push(request.baseRevision);
      // A user edit interleaved after application: only the approved
      // revision may save, anything else fails without touching text.
      if (request.baseRevision !== liveRevision) throw new Error("stale revision");
      return { documentId: request.documentId, revision: liveRevision, dirty: false };
    };
    const ports = reviewPorts(approveCopy, fetchSnapshot, saveDocument);
    const calm = await approveAndSaveStagedCopy(ports, "copy_1");
    expect(calm.saved).toEqual([{ documentId: "doc_a", saved: true }]);
    expect(calm.snapshots).toEqual([snapshot("doc_a", 4, "applied text")]);
    liveRevision = 5;
    const conflicted = await approveAndSaveStagedCopy(ports, "copy_1");
    expect(seen).toEqual([4, 4]);
    expect(conflicted.saved).toEqual([
      { documentId: "doc_a", saved: false, error: "stale revision" },
    ]);
    expect(conflicted.snapshots).toEqual([snapshot("doc_a", 5, "applied text")]);
  });

  it("records snapshot-fetch failures without attempting a save", async () => {
    const saved: string[] = [];
    /** Fake approval returning one applied outcome. */
    const approveCopy = async (copyId: string) => ({ copyId, outcomes: [appliedOutcome("doc_a", 4)] });
    /** Fake snapshot reader failing like a lost buffer. */
    const fetchSnapshot = async () => { throw new Error("snapshot gone"); };
    /** Fake save recording every attempted document. */
    const saveDocument = async (request: { documentId: string; baseRevision: number }) => {
      saved.push(request.documentId);
      return { documentId: request.documentId, revision: 4, dirty: false };
    };
    const result = await approveAndSaveStagedCopy(
      reviewPorts(approveCopy, fetchSnapshot, saveDocument),
      "copy_1",
    );
    expect(result.snapshots).toEqual([]);
    expect(result.saved).toEqual([{ documentId: "doc_a", saved: false, error: "snapshot gone" }]);
    expect(saved).toEqual([]);
  });

  it("keeps partial save failures per document without hiding them", async () => {
    /** Fake approval applying two documents. */
    const approveCopy = async (copyId: string) => ({
      copyId,
      outcomes: [appliedOutcome("doc_a", 4), appliedOutcome("doc_b", 2)],
    });
    /** Fake snapshot reader returning clean text. */
    const fetchSnapshot = async (documentId: string) => snapshot(documentId, 0, "text");
    /** Fake save failing only the second document. */
    const saveDocument = async (request: { documentId: string; baseRevision: number }) => {
      if (request.documentId === "doc_b") throw new Error("disk changed");
      return { documentId: request.documentId, revision: 0, dirty: false };
    };
    const result = await approveAndSaveStagedCopy(
      reviewPorts(approveCopy, fetchSnapshot, saveDocument),
      "copy_1",
    );
    expect(result.saved).toEqual([
      { documentId: "doc_a", saved: true },
      { documentId: "doc_b", saved: false, error: "disk changed" },
    ]);
  });

  it("returns post-save snapshots so saved documents show clean", async () => {
    /** Fake approval applying one document. */
    const approveCopy = async (copyId: string) => ({ copyId, outcomes: [appliedOutcome("doc_a", 4)] });
    let reads = 0;
    /** Fake snapshot reader dirty before the save, clean after it lands. */
    const fetchSnapshot = async (documentId: string) => {
      reads += 1;
      return reads === 1
        ? { documentId, revision: 4, text: "applied text", dirty: true }
        : { documentId, revision: 4, text: "applied text", dirty: false };
    };
    /** Fake save clearing the dirty flag. */
    const saveDocument = async (request: { documentId: string; baseRevision: number }) => (
      { documentId: request.documentId, revision: 4, dirty: false }
    );
    const result = await approveAndSaveStagedCopy(
      reviewPorts(approveCopy, fetchSnapshot, saveDocument),
      "copy_1",
    );
    expect(reads).toBe(2);
    expect(result.saved).toEqual([{ documentId: "doc_a", saved: true }]);
    expect(result.snapshots).toEqual([{ documentId: "doc_a", revision: 4, text: "applied text", dirty: false }]);
  });

  it("reports post-save snapshot failures instead of claiming a clean save", async () => {
    /** Fake approval applying one document. */
    const approveCopy = async (copyId: string) => ({ copyId, outcomes: [appliedOutcome("doc_a", 4)] });
    let reads = 0;
    /** Fake snapshot reader losing the buffer right after the save lands. */
    const fetchSnapshot = async (documentId: string) => {
      reads += 1;
      if (reads > 1) throw new Error("snapshot lost after save");
      return snapshot(documentId, 4, "applied text");
    };
    /** Fake save clearing the dirty flag. */
    const saveDocument = async (request: { documentId: string; baseRevision: number }) => (
      { documentId: request.documentId, revision: 4, dirty: false }
    );
    const result = await approveAndSaveStagedCopy(
      reviewPorts(approveCopy, fetchSnapshot, saveDocument),
      "copy_1",
    );
    expect(reads).toBe(2);
    expect(result.saved).toEqual([{ documentId: "doc_a", saved: false, error: "snapshot lost after save" }]);
    expect(result.snapshots).toEqual([snapshot("doc_a", 4, "applied text")]);
  });
});

describe("staged import orchestration", () => {
  it("passes opened snapshots through for session registration", async () => {
    /** Fake native import opening one document per file. */
    const importNewFiles: ImportPorts["importNewFiles"] = async (copyId, files) => files.map((file) => {
      expect(copyId).toBe("copy_1");
      return {
        rel: file.rel,
        snapshot: snapshot(`doc_${file.rel}`, 0, file.content),
        error: null,
      };
    });
    const imports = await importStagedFiles({ importNewFiles }, "copy_1", [
      { rel: "fresh.md", content: "# Fresh\n" },
    ]);
    expect(imports).toMatchObject([{ rel: "fresh.md", ok: true, documentId: "doc_fresh.md" }]);
    expect(imports[0].snapshot).toEqual(snapshot("doc_fresh.md", 0, "# Fresh\n"));
    expect(imports[0].content).toBe("# Fresh\n");
  });

  it("reports duplicate refusals without claiming success", async () => {
    /** Fake native import refusing an existing path. */
    const importNewFiles: ImportPorts["importNewFiles"] = async (copyId, files) => files.map((file) => {
      expect(copyId).toBe("copy_1");
      return file.rel === "note.md"
        ? { rel: file.rel, snapshot: null, error: "already exists: note.md" }
        : { rel: file.rel, snapshot: snapshot("doc_new", 0, file.content), error: null };
    });
    const imports = await importStagedFiles({ importNewFiles }, "copy_1", [
      { rel: "note.md", content: "# Agent\n" },
      { rel: "fresh.md", content: "# Fresh\n" },
    ]);
    expect(imports.map((item) => [item.rel, item.ok])).toEqual([
      ["note.md", false],
      ["fresh.md", true],
    ]);
    expect(imports[0].error).toContain("already exists");
    expect(imports[0].content).toBe("# Agent\n");
  });

  it("marks native responses missing a file as failed", async () => {
    /** Fake native import dropping a file from its response. */
    const importNewFiles: ImportPorts["importNewFiles"] = async () => [];
    const imports = await importStagedFiles({ importNewFiles }, "copy_1", [
      { rel: "lost.md", content: "# Lost\n" },
    ]);
    expect(imports).toMatchObject([{ rel: "lost.md", ok: false }]);
    expect(imports[0].content).toBe("# Lost\n");
  });

  it("retries only failed imports without reapplying edits", async () => {
    const calls: string[] = [];
    const store = new Map<string, string>();
    /** Fake native import failing a blocked path until unblocked. */
    const importNewFiles: ImportPorts["importNewFiles"] = async (copyId, files) => {
      calls.push(`import:${copyId}`);
      return files.map((file) => {
        if (file.rel === "blocked.md" && !store.has("unblocked")) {
          return { rel: file.rel, snapshot: null, error: "duplicate" };
        }
        store.set(file.rel, file.content);
        return { rel: file.rel, snapshot: snapshot(`doc_${file.rel}`, 0, file.content), error: null };
      });
    };
    const failed = [{ rel: "blocked.md", content: "# Blocked\n" }];
    expect(await importStagedFiles({ importNewFiles }, "copy_1", failed))
      .toMatchObject([{ rel: "blocked.md", ok: false }]);
    store.set("unblocked", "yes");
    expect(await importStagedFiles({ importNewFiles }, "copy_1", failed))
      .toMatchObject([{ rel: "blocked.md", ok: true }]);
    expect(calls).toEqual(["import:copy_1", "import:copy_1"]);
  });
});
