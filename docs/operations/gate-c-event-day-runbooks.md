# Gate C event-day runbooks

Status: readiness draft. Commands and ownership become certifying only after C4
passes and the C5 environment is frozen.

## Operating rules

- Never repair production data with ad-hoc `UPDATE` or `DELETE` statements.
- Never copy scoring URLs, cookies, offline grants, or participant contacts into tickets or evidence.
- Preserve unresolved offline queues unless an export has been created and independently verified.
- Use the application’s versioned correction and repair workflows.
- Record the exact source SHA, incident start/end, operator, and every command executed.
- A correctness or privacy concern outranks availability; fail closed when authority is unclear.

## Pre-event startup

**Trigger:** scheduled event-day opening.

**Owner:** event technical lead.

1. Confirm the deployed source SHA and deployment manifest.
2. Verify PostgreSQL, Redis, Mailpit/notification dependencies, API, web, scheduler, and workers are healthy.
3. Run readiness endpoints and confirm database/Redis latency is inside the frozen C5 budget.
4. Verify the published competition version, divisions, playing areas, and first fixtures.
5. Issue match-scoped scoring passes; do not reuse old passes.
6. Prepare at least one scoring device per active area for offline scoring.
7. Generate and print the published schedule and emergency score sheets.
8. Record the pre-event backup identifier and restoration check.

**Safe fallback:** delay scoring access and use the versioned paper pack if authoritative services are not ready.

**Evidence:** health receipt, source SHA, backup receipt, PDF manifest, device-preparation receipt.

## Official onboarding and device preparation

**Trigger:** an official receives a fixture.

**Owner:** scoring desk lead.

1. Verify match, division, teams, and playing area aloud with the official.
2. Open the one-time match-scoped scoring link on the intended device.
3. Confirm the device label and active-writer status.
4. Select **Prepare offline scoring** while connected.
5. Confirm the offline-ready state and zero pending commands.
6. Explain that finalisation remains pending until the server acknowledges it.
7. Explain the event-history drawer, reversal workflow, and escalation route.

**Safe fallback:** revoke the pass and issue a new pass to the correct device.

**Evidence:** pass ID hash, device/profile hash, match ID, preparation timestamp; never the access token.

## Network outage

**Trigger:** scoring device or venue loses network access.

**Owner:** scoring desk lead.

1. Do not refresh until the device confirms the offline package is ready.
2. Continue recording only on the authorised active-writer device.
3. Watch the pending-command count and stop before the queue limit.
4. Do not transfer writer authority unless the organiser accepts the stale-writer conflict workflow.
5. When connectivity returns, allow ordered replay to finish before finalisation or sign-out.
6. Verify pending count reaches zero and the public result version advances only after acknowledgement.

**Safe fallback:** use the emergency paper score sheet and preserve the device unchanged for later reconciliation.

**Escalate when:** the queue is near capacity, storage corruption appears, replay stops, or authority is uncertain.

**Evidence:** offline/reconnect timestamps, queue counts, conflict code, replay receipt, paper sheet ID when used.

## Stuck replay or writer takeover

**Trigger:** replay remains blocked, a device is lost, or another official must take control.

**Owner:** competition organiser; technical lead advises.

1. Check whether the incumbent device reports pending work.
2. Ask the incumbent to reconnect and sync first.
3. When transfer is unavoidable, record the reason and explicit override acknowledgement.
4. Approve the takeover through the organiser workflow.
5. Confirm the old generation is fenced and read-only.
6. Preserve the stale device queue and export a sanitised diagnostic.
7. Reconcile only through the audited conflict workflow.

**Rollback:** revoke the candidate pass before approval; after approval, do not restore the old generation.

**Evidence:** takeover request/receipt IDs, generation numbers, queue count, conflict ID, diagnostic hash.

## PostgreSQL outage

**Trigger:** readiness reports database failure or writes cannot commit.

**Owner:** platform incident commander.

1. Stop new online mutations and prevent repair/publication attempts.
2. Keep prepared scoring devices in offline mode; do not discard queues.
3. Capture database process, connection-pool, disk, and lock telemetry.
4. Restore the service or promote the approved replica according to infrastructure policy.
5. Run migrations/checks only after confirming the expected schema version.
6. Verify audit/outbox continuity and latest result/publication versions.
7. Reconnect devices in controlled batches and monitor replay backlog.

**Safe fallback:** paper scoring plus offline queues.

**Verification:** zero partial transactions, zero accepted-write loss, projections regenerate to matching versions.

## Redis outage

**Trigger:** Redis health fails or lease/cache operations time out.

**Owner:** platform incident commander.

1. Keep PostgreSQL as the authority; do not infer canonical state from cache.
2. Restart or replace Redis using the pinned configuration.
3. Confirm key namespaces are isolated and stale owned keys are removed safely.
4. Rebuild reconstructible cache/lease state from PostgreSQL.
5. Verify writer fencing before accepting new score events.

**Safe fallback:** prepared offline scoring; pause new writer takeovers.

**Evidence:** Redis version, namespace hashes, before/after key counts, recovery timestamp.

## Result correction and schedule repair

**Trigger:** an official final result is wrong.

**Owner:** organiser with correction permission.

1. Record the correction reason and exact source result version.
2. Submit the correction through the canonical correction workflow.
3. Confirm corrected result, standings, and bracket become public atomically.
4. Confirm the public schedule remains on the previous published revision.
5. Open the generated repair case and inspect direct/transitive descendants.
6. Preserve started, finalised, operationally locked, and manually controlled matches.
7. Resolve every required decision with a reason.
8. Preview the exact public changes and publish with expected result/schedule versions.
9. Verify the new schedule version, ETag, audit, outbox, and publication receipt.

**Rollback:** a failed publication leaves the old public schedule intact; create a new repair revision rather than mutating history.

## Public projection issue

**Trigger:** public schedule/results/standings/bracket disagree or appear stale.

**Owner:** technical lead.

1. Record response ETag, result version, schedule version, projection version, and source-updated timestamp.
2. Compare them with the immutable publication records.
3. Purge only the affected cache key/version; do not rewrite publication rows.
4. Regenerate the projection from retained source revisions.
5. Verify privacy allowlist and multi-division isolation before reopening traffic.

**Evidence:** mismatched and corrected response hashes, cache action, regeneration receipt.

## PDF fallback and emergency paper scoring

**Trigger:** live scoring is unavailable or venue procedures require paper.

**Owner:** scoring desk lead.

1. Use only documents from the current published schedule version.
2. Verify manifest SHA-256, match code, division, teams, time, and playing area.
3. Record scores, incidents, officials, and signatures on the sport-specific sheet.
4. Assign the sheet identifier to the later reconciliation record.
5. Enter the result through the audited correction/import workflow when services return.
6. Retain the original paper according to event policy.

## Backup and restore drill

**Trigger:** scheduled rehearsal or disaster recovery.

**Owner:** database owner.

1. Record source SHA, schema migration list, backup ID, and source database version.
2. Restore into an isolated database.
3. Run migration verification and integrity checks.
4. Compare counts/hashes for score events, results, repairs, publications, audit, and outbox.
5. Regenerate public projections and verify exact versions.
6. Record RPO, RTO, missing/orphaned rows, and projection mismatches.

## Incident escalation

Escalate immediately for any of:

- accepted score event missing or duplicated;
- cross-competition or cross-account data visibility;
- stale writer mutating after takeover;
- private data in a public response, PDF, log, or evidence artifact;
- partially published correction or repair;
- unrecoverable offline queue;
- audit or outbox discontinuity.

The incident commander decides whether to stop the event, continue on paper, or resume digital scoring. Convenience does not override authoritative-state uncertainty.

## Event shutdown and archive

1. Confirm every match is final or has an explicit unresolved incident.
2. Confirm all offline queues are zero or exported and assigned to an incident.
3. Generate final published schedule/results documents and manifests.
4. Take and verify the post-event backup.
5. Revoke remaining scoring passes.
6. Review open repair/conflict cases.
7. Archive only after public versions and evidence are complete.
8. Verify archived competitions are readable but reject mutation.
