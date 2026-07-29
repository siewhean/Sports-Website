import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const scoringSource = new URL("../../components/phase2/PhoneScoring.tsx", import.meta.url);
const phase2Source = new URL("../../lib/phase2.ts", import.meta.url);

describe("Gate C3 offline scoring UI contract", () => {
  it("keeps preparation explicit and exposes deterministic replay and diagnostic actions", async () => {
    const source = await readFile(scoringSource, "utf8");
    const copy = await readFile(phase2Source, "utf8");

    expect(copy).toContain('offlinePrepareAction: "Prepare offline scoring"');
    expect(source).toContain("establishAuthority(summary, phase2Machine.offlinePrepareIntent)");
    expect(source).toContain("revokeAuthority(phase2Machine.offlinePreparationRollbackIntent)");
    expect(source).toContain("discardResolvedAuthorization(matchPackage.authorization_id)");
    expect(copy).toContain("Offline authority was rolled back safely.");
    expect(copy).toContain('offlineSyncNow: "Sync now"');
    expect(copy).toContain('offlineDiagnosticAction: "Export sanitized diagnostic"');
    expect(copy).toContain("Finalised on this device — Pending server confirmation");
    expect(copy).toContain('offlineEndSession: "End scoring session"');
    expect(source).toContain("discardAfterExport");
    expect(source).toContain("discardResolvedAuthorization");
  });

  it("keeps the principal marker available through the bounded offline replay window", async () => {
    const source = await readFile(scoringSource, "utf8");

    expect(source).toContain("retainScoringPrincipalCookie(session.principalId, matchPackage.replay_expires_at)");
    expect(source).toContain(
      "retainScoringPrincipalCookie(recovered.session.principalId, recovered.matchPackage.replay_expires_at)",
    );
  });

  it("locks scoring while authoritative recovery or ordered replay is in progress", async () => {
    const source = await readFile(scoringSource, "utf8");

    expect(source).toContain("offlineState === phase2Machine.offlineReconnecting");
    expect(source).toContain("offlineState === phase2Machine.offlineReplaying");
    expect(source).toContain("pendingCount >= gateCOfflineQueueLimit");
  });

  it("retains explicit expired, revoked, transferred and storage-error states", async () => {
    const source = await readFile(scoringSource, "utf8");

    for (const state of ["expired", "revoked", "read-only", "conflict", "storage-error"]) {
      expect(source).toContain(`"${state}"`);
    }
  });

  it("dismisses terminal action dialogs and deliberately focuses the named offline status", async () => {
    const source = await readFile(scoringSource, "utf8");

    expect(source).toContain("if (actionDialogRef.current?.open) actionDialogRef.current.close()");
    expect(source).toContain("offlineStatusRef.current?.focus({ preventScroll: true })");
    expect(source).toContain("ref={offlineStatusRef}");
    expect(source).toContain('aria-labelledby="offline-state-title"');
    expect(source).toContain("tabIndex={-1}");
  });

  it("shows corrupt offline storage visibly before access can be revalidated", async () => {
    const source = await readFile(scoringSource, "utf8");

    expect(source).toContain('id="offline-access-storage-title"');
    expect(source).toContain("{phase2Copy.offlineStorageRecoveryError}");
    expect(source).toContain(
      "window.requestAnimationFrame(() => offlineStatusRef.current?.focus({ preventScroll: true }))",
    );
  });

  it("does not prefetch the public route while an offline finalisation receipt settles", async () => {
    const source = await readFile(scoringSource, "utf8");

    expect(source).toContain("href={`/competitions/${encodeURIComponent(competitionSlug)}`}");
    expect(source).toContain("prefetch={false}");
  });

  it("cancels replay before revoking and discarding an offline scoring session", async () => {
    const source = await readFile(scoringSource, "utf8");

    expect(source).toContain("resources.replay.replay(offlineAuthorizationId, replayAbort.signal)");
    expect(source).toContain("if (replayAbort.signal.aborted) return");
    expect(source).toContain("offlineReplayAbortRef.current?.abort()");
  });

  it("does not overlap periodic recovery with offline recording or ordered replay", async () => {
    const source = await readFile(scoringSource, "utf8");

    expect(source).toMatch(
      /!transportOnlineRef\.current \|\|\s*!navigator\.onLine \|\|\s*offlineReplayAbortRef\.current/u,
    );
    expect(source).toMatch(
      /if \(!transportOnlineRef\.current \|\| !navigator\.onLine\) \{\s*void device\.then\(\(\) => recoverStoredOfflineSession\(\)\)\.finally\(\(\) => setAccessChecking\(false\)\)/u,
    );
    expect(source).toMatch(
      /if \(!transportOnlineRef\.current \|\| !navigator\.onLine\) \{\s*setOfflineState\(phase2Machine\.offlinePendingSync\);\s*return Promise\.resolve\(\)/u,
    );
    expect(source).toMatch(
      /const offline = \(\) => \{\s*if \(!subscribed\) return;\s*transportOnlineRef\.current = false/u,
    );
    expect(source).toMatch(
      /const online = \(\) => \{\s*if \(!subscribed\) return;\s*transportOnlineRef\.current = true/u,
    );
  });
});
