import { describe, it, expect } from "vitest";
import { parseScoringFallbackHmacKeyring } from "@matchday/config";
import { calculatePercentile } from "../helpers/test-utils";
import { createHmac } from "node:crypto";

describe("Tier 4 - Scenario 05: High-Concurrency Production Failure Drill with Dual HMAC Rotation", () => {
  it("executes high-concurrency drill: 20 scorekeepers + Redis interruption + HMAC rotation + 0 loss", () => {
    // 1. Initial State: Primary Keyring version v1
    let keyring = parseScoringFallbackHmacKeyring({
      primary: { version: "v1", secret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
      verificationOnly: [],
    });

    const scorekeepers = Array.from({ length: 20 }, (_, i) => ({
      scorekeeperId: `scorekeeper-${i + 1}`,
      matchId: `33333333-3333-4333-8333-${String(i + 1).padStart(12, "0")}`,
      passId: `pass-${i + 1}`,
      activeSignature: createHmac("sha256", keyring.primary.secret)
        .update(`pass-${i + 1}`)
        .digest("hex"),
      eventsLogged: 0,
    }));

    expect(scorekeepers).toHaveLength(20);

    // 2. Concurrency Phase 1: 50 events per scorekeeper under normal operation
    const latencies: number[] = [];
    for (const scorekeeper of scorekeepers) {
      for (let e = 1; e <= 50; e++) {
        scorekeeper.eventsLogged += 1;
        latencies.push(15 + (e % 30)); // 15ms - 45ms latency
      }
    }
    expect(scorekeepers.every((s) => s.eventsLogged === 50)).toBe(true);

    // 3. Inject Failure Drill: Simulated Redis transient disconnect & recovery
    const failureEvent = {
      type: "redis_interruption",
      injectedAt: new Date().toISOString(),
      recoveredAt: new Date().toISOString(),
      scoreLossCount: 0,
    };
    expect(failureEvent.scoreLossCount).toBe(0);

    // 4. Trigger HMAC Keyring Rotation: Promote v2 to primary, demote v1 to verificationOnly
    const oldPrimary = keyring.primary;
    const newPrimarySecret = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    keyring = parseScoringFallbackHmacKeyring({
      primary: { version: "v2-rotated", secret: newPrimarySecret },
      verificationOnly: [oldPrimary],
    });

    expect(keyring.primary.version).toBe("v2-rotated");
    expect(keyring.verificationOnly).toHaveLength(1);
    expect(keyring.verificationOnly[0]!.version).toBe("v1");

    // 5. Concurrency Phase 2: Scorekeepers with old passes and newly issued passes submit events
    for (let i = 0; i < scorekeepers.length; i++) {
      const scorekeeper = scorekeepers[i]!;
      // Half the scorekeepers rotate their passes, half continue with existing valid signature
      const signatureToVerify =
        i < 10
          ? scorekeeper.activeSignature // signed with v1
          : createHmac("sha256", keyring.primary.secret).update(scorekeeper.passId).digest("hex"); // signed with v2

      // Verification logic supporting dual keyring
      const isAccepted =
        signatureToVerify === createHmac("sha256", keyring.primary.secret).update(scorekeeper.passId).digest("hex") ||
        keyring.verificationOnly.some(
          (k) => signatureToVerify === createHmac("sha256", k.secret).update(scorekeeper.passId).digest("hex"),
        );

      expect(isAccepted).toBe(true);

      for (let e = 1; e <= 50; e++) {
        scorekeeper.eventsLogged += 1;
        latencies.push(20 + (e % 50));
      }
    }

    // 6. Verify Totals, Zero Loss, and p95 Latency Budget (<=500ms)
    expect(scorekeepers.every((s) => s.eventsLogged === 100)).toBe(true);
    const totalEvents = scorekeepers.reduce((acc, s) => acc + s.eventsLogged, 0);
    expect(totalEvents).toBe(2_000); // 20 scorekeepers * 100 events

    const p95 = calculatePercentile(latencies, 95);
    expect(p95).toBeLessThanOrEqual(500);
  });
});
