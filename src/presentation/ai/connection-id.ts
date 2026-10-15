import { pickConnectionId } from "../../domain/ai-connections";

/** Draw one `api-` hex candidate from cryptographic randomness. */
function drawRandomId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `api-${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Mint one stable connection ID colliding with none of the existing IDs.
 *
 * Outer real-use randomness lives here, outside the pure domain: the domain
 * picks deterministically from these candidates with a bounded fallback, so
 * registration keeps working even under entropy failure. Tests should
 * prefer the pure domain picker with fixed candidates instead.
 */
export function mintConnectionId(existing: readonly string[]): string {
  try {
    const candidates: string[] = [];
    for (let attempt = 0; attempt < 100; attempt += 1) candidates.push(drawRandomId());
    return pickConnectionId(existing, candidates);
  } catch {
    return pickConnectionId(existing, [`api-${Date.now().toString(36)}`]);
  }
}
