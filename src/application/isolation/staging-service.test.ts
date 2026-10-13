import { describe, expect, it } from "vitest";
import { japaneseTranslator, renderLocalizedText } from "../../domain/localization";
import { summarizeSavedResult } from "./staging-service";

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
