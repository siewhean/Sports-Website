import { describe, expect, it } from "vitest";
import type { PostgresJsSql, SessionRecord } from "@matchday/identity";
import { PostgresAssuranceSessionRepository } from "../../src/identity-assurance-session-repository.js";

function sessionRecord(): SessionRecord {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    accountId: "00000000-0000-4000-8000-000000000002",
    secretHash: "a".repeat(64),
    createdAt: new Date("2026-08-14T00:00:00.000Z"),
    lastSeenAt: new Date("2026-08-14T00:00:00.000Z"),
    idleExpiresAt: new Date("2026-08-14T00:30:00.000Z"),
    absoluteExpiresAt: new Date("2026-08-14T12:00:00.000Z"),
    revokedAt: null,
    providerIssuer: "https://identity.example.test",
    providerSubject: "provider-subject",
    providerSessionId: "provider-session",
    assurance: {
      level: "phishing_resistant",
      methods: ["pwd", "mfa"],
      acr: "https://matchday.example/assurance/phishing-resistant",
      authenticatedAt: new Date("2026-08-13T23:59:00.000Z"),
      mfaPerformed: true,
      phishingResistant: true,
    },
  };
}

describe("PostgresAssuranceSessionRepository", () => {
  it("writes the assurance row through the same transaction-scoped SQL adapter", async () => {
    const calls: { query: string; params: readonly unknown[] }[] = [];
    const sql = {
      unsafe: async (query: string, params: readonly unknown[] = []) => {
        calls.push({ query, params });
        return [];
      },
    } as unknown as PostgresJsSql;
    const repository = new PostgresAssuranceSessionRepository(sql);

    await repository.create(sessionRecord());

    expect(calls).toHaveLength(2);
    expect(calls[0]?.query).toContain("INSERT INTO identity_sessions");
    expect(calls[1]?.query).toContain("INSERT INTO identity_session_assurance");
    expect(calls[1]?.params).toMatchObject([
      "00000000-0000-4000-8000-000000000001",
      "phishing_resistant",
      ["pwd", "mfa"],
    ]);
  });

  it("reconstructs persisted assurance on session reads", async () => {
    const base = sessionRecord();
    const sql = {
      unsafe: async (query: string) => {
        if (query.includes("FROM identity_sessions")) {
          return [
            {
              id: base.id,
              account_id: base.accountId,
              secret_hash: base.secretHash,
              created_at: base.createdAt,
              last_seen_at: base.lastSeenAt,
              idle_expires_at: base.idleExpiresAt,
              absolute_expires_at: base.absoluteExpiresAt,
              revoked_at: null,
              provider_issuer: base.providerIssuer,
              provider_subject: base.providerSubject,
              provider_session_id: base.providerSessionId,
            },
          ];
        }
        if (query.includes("FROM identity_session_assurance")) {
          return [
            {
              assurance_level: "phishing_resistant",
              authentication_methods: ["pwd", "mfa"],
              acr: "https://matchday.example/assurance/phishing-resistant",
              authenticated_at: new Date("2026-08-13T23:59:00.000Z"),
              mfa_performed: true,
              phishing_resistant: true,
            },
          ];
        }
        return [];
      },
    } as unknown as PostgresJsSql;
    const repository = new PostgresAssuranceSessionRepository(sql);

    await expect(repository.findById(base.id)).resolves.toMatchObject({
      id: base.id,
      assurance: {
        level: "phishing_resistant",
        methods: ["pwd", "mfa"],
        mfaPerformed: true,
        phishingResistant: true,
      },
    });
  });
});
