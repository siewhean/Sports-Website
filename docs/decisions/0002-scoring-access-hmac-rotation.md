# ADR 0002 — Defer scoring-access HMAC key rotation to C5

**Status:** Accepted for C1 follow-up; required before C5 operational certification

## Context

Gate C C1 currently uses one HMAC secret to derive both Redis rate-limit namespaces and persisted scoring-access attempt fingerprints. A partial key-ring change at the call site would split counters between key versions, reset abuse history during rotation, and make persisted attempt records unverifiable without a schema version.

Rotation therefore requires one coordinated operational change:

- persist an explicit HMAC key version with every attempt fingerprint;
- configure one primary key plus verification-only previous keys;
- aggregate active Redis counters and cooldown state across accepted versions;
- make new writes use only the primary version;
- reject unknown or retired versions;
- prevent retirement until the maximum Redis TTL has elapsed and no unexpired persisted access attempt/pass depends on the version;
- audit key-version activation and retirement without recording key material, access codes, digests, tokens, or session secrets.

Implementing only the configuration parser or only dual verification would create a false rotation claim and could weaken fallback-code rate limiting.

## Decision

Do not implement a partial key-ring during the C1 collision and responsive follow-up. Keep the existing C1 HMAC key stable and track full versioned rotation as a C5 operational deliverable.

C2 may proceed only after the C1 collision and 320 CSS-pixel reflow fixes are recertified. C5 cannot pass until versioned HMAC rotation, backward compatibility, retirement controls, metrics continuity, and secret-redaction tests are complete.

## Required C5 evidence

- migration adds a non-null key version to persisted attempt fingerprints with a safe backfill;
- old and new versions verify during the overlap window;
- new attempts use only the primary version;
- Redis limits cannot be bypassed by switching key versions;
- unknown and retired versions fail closed;
- retirement is blocked while dependent TTL/data remains;
- logs, audit, metrics, evidence, and provider payloads contain versions and counts only;
- rotation and rollback are rehearsed against the exact release candidate.
