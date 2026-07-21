import { describe, expect, it } from "vitest";
import { SessionService } from "../src/session.js";
import {
  DeterministicOpaqueTokenGenerator,
  InMemoryAccountRepository,
  InMemorySessionRepository,
  deterministicAccount,
} from "../src/testing.js";

describe("SessionService", () => {
  function setup() {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const accounts = new InMemoryAccountRepository();
    const sessions = new InMemorySessionRepository();
    const account = deterministicAccount();
    accounts.seed(account);
    const service = new SessionService(
      sessions,
      accounts,
      { now: () => now },
      new DeterministicOpaqueTokenGenerator(),
      { idleTtlMs: 1_000, absoluteTtlMs: 3_000 },
    );
    return { accounts, sessions, account, service, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
  }

  it("authenticates and renews idle expiry without extending absolute expiry", async () => {
    const fixture = setup();
    const issued = await fixture.service.issue(fixture.account);
    fixture.advance(500);
    const authenticated = await fixture.service.authenticate(issued.sessionToken);
    expect(authenticated.idleExpiresAt.toISOString()).toBe("2026-01-01T00:00:01.500Z");
    expect(authenticated.absoluteExpiresAt.toISOString()).toBe("2026-01-01T00:00:03.000Z");
  });

  it("rejects malformed and tampered session tokens", async () => {
    const fixture = setup();
    const issued = await fixture.service.issue(fixture.account);
    await expect(fixture.service.authenticate("malformed")).rejects.toMatchObject({
      code: "INVALID_SESSION",
    });
    await expect(
      fixture.service.authenticate(`${issued.sessionId}.tampered-session-secret-00000000`),
    ).rejects.toMatchObject({ code: "INVALID_SESSION" });
  });

  it("revokes an idle-expired session and rejects reuse", async () => {
    const fixture = setup();
    const issued = await fixture.service.issue(fixture.account);
    fixture.advance(1_000);
    await expect(fixture.service.authenticate(issued.sessionToken)).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
    });
    await expect(fixture.service.authenticate(issued.sessionToken)).rejects.toMatchObject({
      code: "SESSION_REVOKED",
    });
  });

  it("revokes sessions when their account is locked", async () => {
    const fixture = setup();
    const issued = await fixture.service.issue(fixture.account);
    fixture.accounts.accounts.set(fixture.account.id, { ...fixture.account, status: "locked" });
    await expect(fixture.service.authenticate(issued.sessionToken)).rejects.toMatchObject({
      code: "ACCOUNT_INACTIVE",
    });
    expect(fixture.sessions.sessions.get(issued.sessionId)?.revokedAt).toBeInstanceOf(Date);
  });

  it("signs out idempotently without revealing whether a valid session exists", async () => {
    const fixture = setup();
    const issued = await fixture.service.issue(fixture.account);
    await fixture.service.signOut(issued.sessionToken);
    await fixture.service.signOut(issued.sessionToken);
    expect(fixture.sessions.sessions.get(issued.sessionId)?.revokedAt).toBeInstanceOf(Date);
  });
});
