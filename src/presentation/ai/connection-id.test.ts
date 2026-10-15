import { describe, expect, it } from "vitest";
import { isConnectionId } from "../../domain/ai-connections";
import { mintConnectionId } from "./connection-id";

describe("named connection ID minting", () => {
  it("mints valid IDs colliding with none of the existing ones", () => {
    const first = mintConnectionId([]);
    expect(isConnectionId(first)).toBe(true);
    const second = mintConnectionId([first]);
    expect(isConnectionId(second)).toBe(true);
    expect(second).not.toBe(first);
  });
});
