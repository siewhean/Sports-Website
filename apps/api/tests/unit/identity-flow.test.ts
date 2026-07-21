import { describe, expect, it } from "vitest";
import { IdentityFlowSealer, identityFlowTtlMs } from "../../src/identity-flow.js";

const key = Buffer.alloc(32, 23).toString("base64url");
const flow = {
  state: "s".repeat(43),
  nonce: "n".repeat(43),
  pkceVerifier: "v".repeat(43),
  returnUri: "https://app.matchday.test/organiser",
};

describe("IdentityFlowSealer", () => {
  it("round-trips a five-minute flow without exposing plaintext", () => {
    const sealer = new IdentityFlowSealer(key, () => 10_000);
    expect(JSON.stringify(sealer)).not.toContain(key);
    const sealed = sealer.seal(flow);
    expect(sealed).not.toContain(flow.state);
    expect(sealed).not.toContain(flow.pkceVerifier);
    expect(sealer.open(sealed)).toEqual({ ...flow, issuedAt: 10_000, expiresAt: 10_000 + identityFlowTtlMs });
  });

  it("rejects tampering, expiry, and non-canonical keys", () => {
    let now = 20_000;
    const sealer = new IdentityFlowSealer(key, () => now);
    const sealed = sealer.seal(flow);
    const last = sealed.at(-1) === "a" ? "b" : "a";
    expect(() => sealer.open(`${sealed.slice(0, -1)}${last}`)).toThrow("Authentication could not be completed");
    now += identityFlowTtlMs;
    expect(() => sealer.open(sealed)).toThrow("Authentication could not be completed");
    expect(() => new IdentityFlowSealer("a".repeat(43))).toThrow("exactly 32 bytes");
  });

  it("uses a constant-time equality boundary for state values", () => {
    const sealer = new IdentityFlowSealer(key);
    expect(sealer.stateMatches(flow.state, flow.state)).toBe(true);
    expect(sealer.stateMatches(flow.state, `${flow.state.slice(0, -1)}x`)).toBe(false);
    expect(sealer.stateMatches(flow.state, "short")).toBe(false);
  });
});
