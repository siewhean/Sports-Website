# Public-data and retention policy

Status: **Provisional product baseline — privacy/legal approval required before launch**

This is the local decision draft for `VAL-006`. Public pages use an allow-list. Fields not listed as public are private by default.

## Visibility matrix

| Data                                                              | Default               | Organiser control                            | Constraints                                                                           |
| ----------------------------------------------------------------- | --------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| Competition name, sport, dates, venue, timezone, published status | Public                | May unpublish competition                    | Only the published revision appears                                                   |
| Division name, entry/team display name, club/association, country | Public                | May hide optional club/country metadata      | No private registration metadata                                                      |
| Seed, schedule, result, table, bracket, next possible match       | Public once published | Seed may be hidden before event start        | Last-updated state is visible                                                         |
| Player name                                                       | Hidden                | Opt-in per competition                       | Warning plus organiser confirmation of consent; team names only by default for minors |
| Player number/role                                                | Hidden                | Available only when player names are enabled | Never expose date of birth, age, or minor status                                      |
| Email, phone, address, emergency contact, payment/import notes    | Never public          | None                                         | Excluded from public APIs, caches, analytics, and search indexes                      |
| Referee/official name                                             | Hidden                | Opt-in per competition in the first release  | Organiser confirms the person has agreed; final consent wording requires approval     |
| Audit actor identity and reason                                   | Private               | Organiser export only                        | Public pages may show that a correction occurred, not private actor data              |

## Minors and consent

- Team or entry names are the player-level public default.
- Enabling individual names requires an explicit organiser confirmation that appropriate consent and governing-body requirements are satisfied.
- The confirmation stores actor, time, policy version, and competition ID.
- No date of birth, exact age, contact data, consent evidence, or “minor” flag appears publicly.
- Revoking the toggle removes player names from public responses and future caches/search indexing; retained audit evidence remains private.

## Retention and deletion

| Record class                 | Baseline                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Active competition           | Retain while the organiser account exists                                                                                     |
| Archived competition         | Purge two years after archival                                                                                                |
| Audit log                    | Retain one year, unless a lawful hold applies                                                                                 |
| Deleted account              | Remove public access immediately; purge primary data after 30 days                                                            |
| Competition deletion request | Unpublish immediately; provisional 30-day recovery period, then purge subject to legal/audit obligations                      |
| Operational logs             | PII-scrubbed; 90-day target from the production checklist                                                                     |
| Backups                      | Provisional: expire through normal rotation after primary purge; exact maximum age requires infrastructure and legal approval |

An archived competition past retention returns HTTP 410. A deleted or unpublished competition must not remain discoverable through public search. Deletion jobs must be idempotent and produce a private completion record without retaining erased personal content.

## Rights and exports

- Organisers can export their competition data and audit history before deletion.
- Requests concerning an individual’s data are routed to a documented support/privacy process and verified before disclosure or deletion.
- Export files inherit the same privacy classification and must not place private fields in public URLs.
- Legal hold, fraud, billing, and safety exceptions require a documented basis and restricted access.

## Required controls

- Public APIs project allow-listed fields rather than serialising domain records.
- Public responses and logs are tested for contact-data leakage.
- Cache invalidation runs after privacy-toggle, correction, unpublish, archive, and deletion events.
- Referee and player visibility changes are audited.
- Non-essential analytics remain disabled until granular cookie consent.

## Cookies and analytics consent

- Consent has three categories: **essential**, **analytics**, and **marketing**. Essential storage may operate without opt-in only where required for security, authentication, accessibility, or a user-requested service.
- Analytics and marketing adapters start disabled. No non-essential cookie, browser storage, pixel, beacon, or event export may run before the corresponding opt-in.
- The consent record stores an opaque subject/browser identifier, policy version, category choices, and recorded/updated timestamps. It must not contain a QR pass, scoring credential, raw access token, or public-player consent evidence.
- People can reopen preferences and withdraw a category as easily as they granted it. Withdrawal stops future collection; deletion or retention of already collected analytics follows the published privacy notice and approved vendor contract.
- Product analytics use data minimisation: no full email address, contact data, free-text notes, QR/code secrets, or unredacted URLs. Competition, account, and device identifiers are pseudonymous where the metric does not require identity.
- Consent behavior and analytics payloads require browser tests proving pre-consent blocking, category isolation, persistence, withdrawal, and absence of private-field leakage. Vendor configuration and legal wording remain external approval evidence.

## Approval checklist

- [ ] Privacy/legal reviewer approves fields, consent wording, retention, deletion, backups, and export-right handling.
- [ ] Youth/federation partner approves the minors default.
- [ ] Product owner approves the first-release referee visibility default and consent wording.
- [ ] Infrastructure owner states the backup-rotation maximum and validates deletion propagation.
- [ ] Published privacy and cookie notices match this implemented policy.

Source: specification §§8.17, 9.4, 20; tasks `VAL-006`, `RES-024`, `RES-025`, `OPS-007`.
