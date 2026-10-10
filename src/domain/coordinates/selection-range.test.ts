import { describe, expect, it } from "vitest";
import { correspondSource, resolveEditRange, sliceRange } from "./selection-range";

describe("exact half-open selection ranges", () => {
  it("replaces a forward selection once, then collapses bursts", () => {
    expect(resolveEditRange(10, 2, 7, 7)).toEqual({ start: 2, end: 7 });
    // After the first edit collapses the caret, bursts advance collapsed.
    expect(resolveEditRange(10, 2, 7, 3)).toEqual({ start: 3, end: 3 });
  });

  it("normalizes a reverse selection to min/max", () => {
    expect(resolveEditRange(10, 7, 2, 2)).toEqual({ start: 2, end: 7 });
  });

  it("preserves Unicode spans on UTF-16 offsets", () => {
    const text = "a😀b\nc";
    // 😀 occupies two UTF-16 units: selecting across it keeps the pair whole.
    expect(resolveEditRange(text.length, 1, 4, 4)).toEqual({ start: 1, end: 4 });
    expect(sliceRange(text, { start: 1, end: 4 })).toBe("😀b");
  });

  it("preserves newline spans across lines", () => {
    const text = "ab\ncd\nef";
    expect(resolveEditRange(text.length, 0, 5, 5)).toEqual({ start: 0, end: 5 });
    expect(sliceRange(text, { start: 0, end: 5 })).toBe("ab\ncd");
  });

  it("clamps untrusted offsets but never the own projected caret", () => {
    // A fresh selection still replaces exactly once.
    expect(resolveEditRange(4, 0, 4, 4)).toEqual({ start: 0, end: 4 });
    // The own projection survives clamping so rapid input cannot reverse.
    expect(resolveEditRange(4, 0, 99, 99)).toEqual({ start: 99, end: 99 });
    expect(resolveEditRange(0, 0, 0, 2)).toEqual({ start: 2, end: 2 });
    expect(resolveEditRange(4, -3, 2, 2)).toEqual({ start: 0, end: 2 });
    expect(sliceRange("abcd", { start: 2, end: 99 })).toBe("cd");
  });

  it("admits a stale retry only on full source equality", () => {
    expect(correspondSource("hello world", "hello world", { start: 6, end: 11 })).toEqual({ start: 6, end: 11 });
    // Same excerpt at the same offset is not enough: shifted context rejects.
    expect(correspondSource("!hello world", "hello world", { start: 6, end: 11 })).toBeNull();
    expect(correspondSource("hello!", "hello world", { start: 0, end: 0 })).toBeNull();
    // Identical source retries at the clamped range.
    expect(correspondSource("hi", "hi", { start: 0, end: 0 })).toEqual({ start: 0, end: 0 });
    expect(correspondSource("hi", "hi", { start: 50, end: 50 })).toEqual({ start: 2, end: 2 });
  });
});
