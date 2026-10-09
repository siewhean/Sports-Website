# Launch checklist

Items that must be completed by the owner before public launch. Add rows as other workstreams create them.

## Legal and privacy placeholders (PDPA)

The privacy policy (`/privacy`) and terms (`/terms`) render these placeholders as highlighted text so they cannot be missed. Replace each value in `packages/ui/src/legal.ts` (`legalPlaceholders`), then update `legalMessages.updatedOn`.

| Placeholder                           | Where it appears                                    | Done |
| ------------------------------------- | --------------------------------------------------- | ---- |
| `[ORGANISATION LEGAL NAME]`           | Privacy "Who we are"; Terms "Who provides Matchday" | [ ]  |
| `[UEN / REGISTRATION NUMBER]`         | Privacy, Terms                                      | [ ]  |
| `[REGISTERED ADDRESS]`                | Privacy, Terms                                      | [ ]  |
| `[DPO EMAIL]`                         | Privacy (DPO, rights), Terms                        | [ ]  |
| `[COURTS / DISPUTE RESOLUTION FORUM]` | Terms "Governing law and disputes"                  | [ ]  |

Also before launch:

- [ ] Appoint a data protection officer, monitor the DPO mailbox and commit to the 30-day response time stated in the policy.
- [ ] Have counsel review the privacy policy and terms (especially the overseas-transfer wording and the Singapore governing-law clause).
- [ ] Confirm the provider list in the policy still matches production (Auth0, Vercel, OCI Singapore, Sentry, the email provider, the payment provider) and that data-processing terms are signed with each.
- [ ] Deleting an account anonymises it in MATCHDAY only. Decide how the Auth0 user record is removed (manual on request via the DPO, or add an Auth0 Management API call) and keep the policy sentence about it accurate.
- [ ] Decide whether recent re-authentication should be required for account deletion (currently: CSRF, allowed Origin and a typed confirmation phrase).
- [ ] Ownership transfer / owner invitations do not exist yet. Sole owners of organisations with published or live competitions cannot delete their account; agree a manual DPO procedure until those routes exist.
- [ ] Run migration `0069_pdpa_retention.sql` and confirm the purge job logs `pdpa retention purge completed` after the first interval.
- [ ] Review the retention defaults below with counsel (billing receipts at 400 days in particular) and change `retentionSchedule` in `packages/ui/src/legal.ts` together with any override.

## PDPA retention configuration

The API runs an advisory-locked, batch-limited purge every `PDPA_PURGE_INTERVAL_MINUTES`. `audit_events` is never purged.

| Environment variable                  | Default | Allowed range | Deletes                                                   |
| ------------------------------------- | ------- | ------------- | --------------------------------------------------------- |
| `PDPA_PURGE_ENABLED`                  | `true`  | true/false    | Kill switch for the whole job                             |
| `PDPA_PURGE_INTERVAL_MINUTES`         | `360`   | 5 - 10080     | Run interval                                              |
| `PDPA_PURGE_BATCH_SIZE`               | `500`   | 10 - 5000     | Rows per batch (20 batches per category per run)          |
| `PDPA_RETENTION_SESSION_DAYS`         | `30`    | 1 - 3650      | Expired or revoked sessions, expired recovery requests    |
| `PDPA_RETENTION_SCORING_ATTEMPT_DAYS` | `30`    | 7 - 3650      | Scoring access attempt records (closed rate-limit window) |
| `PDPA_RETENTION_NOTIFICATION_DAYS`    | `180`   | 7 - 3650      | Notifications, queued emails, email delivery events       |
| `PDPA_RETENTION_BILLING_RECEIPT_DAYS` | `400`   | 90 - 3650     | Billing webhook receipts (whole rows)                     |
| `PDPA_RETENTION_PROVIDER_EVENT_DAYS`  | `90`    | 7 - 3650      | Identity-provider event de-duplication records            |
| `PDPA_RETENTION_CASUAL_ANON_DAYS`     | `30`    | 1 - 3650      | Casual games never claimed by an account                  |

Database note: migration `0068` replaces the append-only trigger on `scoring_access_attempts` with a guard that still rejects every UPDATE and rejects DELETE unless the purge job opted in for the transaction, the row is older than 7 days and its rate-limit window has closed.
