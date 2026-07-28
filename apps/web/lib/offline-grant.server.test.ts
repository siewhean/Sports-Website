import { describe, expect, it } from "vitest";
import {
  expiredOfflineGrantCookie,
  InvalidOfflineGrantError,
  OfflineGrantSealer,
  offlineGrantCookie,
} from "./offline-grant.server";

const KEY = Buffer.alloc(32, 7).toString("base64url");
const NOW = Date.parse("2026-07-28T00:00:00.000Z");
const CREDENTIAL = {
  authorizationId: "00000000-0000-4000-8000-000000000001",
  resumeSecret: "a".repeat(43),
  matchId: "00000000-0000-4000-8000-000000000002",
  replayExpiresAt: "2026-07-28T04:15:00.000Z",
};

describe("offline grant cookie", () => {
  it("seals only the server-held resume credential and rejects tampering", () => {
    const sealer = new OfflineGrantSealer(KEY, () => NOW);
    const sealed = sealer.seal(CREDENTIAL);
    expect(sealer.open(sealed)).toEqual(CREDENTIAL);
    expect(() => sealer.open(`${sealed.slice(0, -1)}x`)).toThrow(InvalidOfflineGrantError);
  });

  it("uses the __Secure prefix with the narrow offline BFF path", () => {
    expect(offlineGrantCookie("sealed", CREDENTIAL.replayExpiresAt, NOW)).toContain(
      "__Secure-matchday-offline-grant=sealed; Path=/api/scoring/offline;",
    );
    expect(offlineGrantCookie("sealed", CREDENTIAL.replayExpiresAt, NOW)).toContain(
      "Secure; HttpOnly; SameSite=Strict",
    );
    expect(expiredOfflineGrantCookie()).toContain("Max-Age=0");
  });

  it("rejects expired credentials", () => {
    const sealer = new OfflineGrantSealer(KEY, () => Date.parse(CREDENTIAL.replayExpiresAt));
    expect(() => sealer.seal(CREDENTIAL)).toThrow(InvalidOfflineGrantError);
  });
});
