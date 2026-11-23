import { describe, expect, it } from "vitest";
import { pdfFileName, splitArguments } from "./pdf-export";

describe("pdf export", () => {
  it("splits settings text like a shell without expanding anything", () => {
    expect(splitArguments("--pdf-engine=lualatex  -V documentclass=ltjsarticle")).toEqual(["--pdf-engine=lualatex", "-V", "documentclass=ltjsarticle"]);
    expect(splitArguments("-V \"mainfont=Noto Sans JP\" -M 'title=A \"B\"' a\\ b \"\"")).toEqual(["-V", "mainfont=Noto Sans JP", "-M", "title=A \"B\"", "a b", ""]);
    expect(splitArguments("  ")).toEqual([]);
    expect(splitArguments("$(rm) `x`")).toEqual(["$(rm)", "`x`"]);
  });

  it("names the PDF after the note or its bundle", () => {
    expect(pdfFileName("memo/plan.md")).toBe("plan.pdf");
    expect(pdfFileName("trip.marxen/index.md")).toBe("trip.pdf");
    expect(pdfFileName(null)).toBe("note.pdf");
  });
});
