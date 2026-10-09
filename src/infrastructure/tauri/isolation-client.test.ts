import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  approveIsolatedCopy,
  cancelIsolatedCopy,
  createIsolatedCopy,
  fetchIsolationDiff,
  rejectIsolatedCopy,
  stageProposal,
} from "./isolation-client";
import { describeIsolationError } from "../../domain/isolation-errors";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));

import { invoke } from "@tauri-apps/api/core";

beforeEach(() => vi.resetAllMocks());

describe("isolation ipc", () => {
  it("creates scoped copies with the exact sent scope", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ copyId: "copy_08", documents: [] });
    const info = await createIsolatedCopy([
      { documentId: "doc_08", revision: 3, ranges: [{ start: 0, end: 5 }], text: "hello" },
    ]);
    expect(info.copyId).toBe("copy_08");
    expect(invoke).toHaveBeenCalledWith("isolation_create", { contexts: expect.any(Array) });
  });

  it("stages proposals then reviews with structured outcomes", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ copyId: "copy_08", updated: ["doc_08"], chars: 11 });
    const staged = await stageProposal(
      "copy_08",
      { text: "hello world", baseContexts: [{ documentId: "doc_08", revision: 3 }] },
      "rewrite",
    );
    expect(staged.updated).toEqual(["doc_08"]);
    expect(invoke).toHaveBeenCalledWith(
      "isolation_stage_proposal",
      expect.objectContaining({ copyId: "copy_08", mode: "rewrite" }),
    );
    vi.mocked(invoke).mockResolvedValueOnce({ copyId: "copy_08", outcomes: [] });
    const result = await approveIsolatedCopy("copy_08");
    expect(result.outcomes).toEqual([]);
    expect(invoke).toHaveBeenCalledWith("isolation_approve", { copyId: "copy_08" });
    await fetchIsolationDiff("copy_08");
    expect(invoke).toHaveBeenCalledWith("isolation_diff", { copyId: "copy_08" });
    await rejectIsolatedCopy("copy_08");
    expect(invoke).toHaveBeenCalledWith("isolation_reject", { copyId: "copy_08" });
    await cancelIsolatedCopy("copy_08");
    expect(invoke).toHaveBeenCalledWith("isolation_cancel", { copyId: "copy_08" });
  });

  it("describes stale, conflict, and detail errors for resync", () => {
    expect(describeIsolationError({ code: "stale_revision" })).toMatch(/再同期/);
    expect(describeIsolationError({ code: "conflict" })).toMatch(/競合/);
    expect(describeIsolationError({ code: "not_found" })).toMatch(/見つかりません/);
    expect(describeIsolationError({ code: "io", detail: "送信範囲が登録した選択範囲の外です" })).toMatch(
      /選択範囲の外/,
    );
  });
});

