import { describe, expect, it } from "vitest";
import { imageFileName } from "./image-name";

const now = new Date(2026, 10, 9, 7, 5, 3);

describe("imageFileName", () => {
  it("keeps the original name by default", () => {
    expect(imageFileName("{name}", "image.PNG", now)).toBe("image.png");
  });

  it("expands date and time tokens", () => {
    expect(imageFileName("{date}-{time}-{name}", "shot.jpg", now)).toBe("2026-11-09-070503-shot.jpg");
  });

  it("replaces characters that cannot appear in a file name", () => {
    expect(imageFileName("a/b:c", "x.png", now)).toBe("a-b-c.png");
  });

  it("falls back to image when the pattern expands to nothing", () => {
    expect(imageFileName("...", "x.webp", now)).toBe("image.webp");
  });
});
