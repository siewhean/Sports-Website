import { randomUUID } from "node:crypto";
import type { PostgresJsSql } from "@matchday/identity";
import { ApiError, ErrorCode } from "./errors.js";

/** Phrase the account holder must type to confirm deletion (shown verbatim in the web UI). */
export const accountDeletionConfirmationPhrase = "DELETE MY ACCOUNT";

/** Competition statuses that make an organisation's sole owner unable to leave. */
const liveCompetitionStatuses = ["published", "active", "live"] as const;

/** Organisations whose billing records the account is entitled to see (active owner). */
const ownedOrganisationIds = `SELECT m.organisation_id FROM organisation_memberships m
  WHERE m.account_id = $1 AND m.role = 'owner' AND m.status = 'active'`;

type Row = Record<string, unknown>;

export type AccountDeletionResult = {
  deleted_at: string;
  revoked_sessions: number;
  removed: {
    notifications: number;
    notification_preferences: number;
    friend_requests: number;
    presets: number;
    sport_defaults: number;
    provider_links: number;
  };
  suspended_memberships: number;
  retained_memberships: number;
};

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

export class AccountDataRightsRuntime {
  constructor(private readonly sql: PostgresJsSql) {}

  private transaction<T>(operation: (tx: PostgresJsSql) => Promise<T>): Promise<T> {
    if (!this.sql.begin) throw new Error("Account data rights require a transaction-capable PostgreSQL client.");
    return Promise.resolve(this.sql.begin(operation));
  }

  private async audit(
    tx: PostgresJsSql,
    input: { requestId: string; accountId: string; action: string; afterState: Row; metadata?: Row },
  ): Promise<void> {
    await tx.unsafe(
      `INSERT INTO audit_events (
         id, request_id, actor_account_id, actor_type, action, target_type, target_id, after_state, metadata
       ) VALUES ($1, $2, $3::uuid, 'account', $4, 'account', $3::uuid::text, $5::jsonb, $6::jsonb)`,
      [
        randomUUID(),
        input.requestId,
        input.accountId,
        input.action,
        JSON.stringify(input.afterState),
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }

  /**
   * PDPA access request: everything personal we hold against the caller's account. Secrets (session
   * hashes, access-token hashes, provider session ids) are never included; other people's personal
   * data (friends' emails or names) is replaced by opaque ids.
   */
  async exportAccountData(accountId: string, requestId: string): Promise<Record<string, unknown>> {
    return this.transaction(async (tx) => {
      const q = (query: string, params: readonly unknown[] = [accountId]) => tx.unsafe<Row>(query, params);

      const account = (
        await q(
          `SELECT id, primary_email, display_name, status, email_verified_at, created_at, updated_at
           FROM accounts WHERE id = $1 AND deleted_at IS NULL`,
        )
      )[0];
      if (!account) throw new ApiError(404, ErrorCode.NOT_FOUND, "Account not found");

      const [
        providerIdentities,
        memberships,
        officialGrants,
        platformRoles,
        preferences,
        notifications,
        sportDefaults,
        casualGames,
        casualPresets,
        casualFriendRequests,
        casualShares,
        sessions,
        billingSubscriptions,
        billingEntitlements,
        billingUsage,
        billingReceipts,
        competitions,
        auditEvents,
      ] = await Promise.all([
        q(
          `SELECT issuer, subject, created_at, last_authenticated_at FROM provider_identities
           WHERE account_id = $1 ORDER BY created_at`,
        ),
        q(
          `SELECT m.organisation_id, o.name AS organisation_name, o.slug AS organisation_slug, m.role, m.status,
                  m.created_at, m.updated_at
           FROM organisation_memberships m JOIN organisations o ON o.id = m.organisation_id
           WHERE m.account_id = $1 ORDER BY m.created_at`,
        ),
        q(
          `SELECT organisation_id, resource_type, resource_id, granted_at, expires_at, revoked_at
           FROM official_grants WHERE account_id = $1 ORDER BY granted_at`,
        ),
        q(
          `SELECT role, granted_at, expires_at, revoked_at FROM account_platform_roles
           WHERE account_id = $1 ORDER BY granted_at`,
        ),
        q(
          `SELECT notification_type, in_app_enabled, email_enabled, updated_at FROM notification_preferences
           WHERE account_id = $1 ORDER BY notification_type`,
        ),
        q(
          `SELECT n.id, n.type, n.payload, n.created_at, n.read_at,
                  (SELECT jsonb_agg(jsonb_build_object(
                     'template_id', e.template_id, 'subject', e.subject, 'status', e.status,
                     'created_at', e.created_at, 'delivered_at', e.delivered_at) ORDER BY e.created_at)
                   FROM notification_email_outbox e WHERE e.notification_id = n.id) AS emails
           FROM notifications n WHERE n.account_id = $1 ORDER BY n.created_at`,
        ),
        q(
          `SELECT sport_code, source_pack_version, settings, updated_at FROM account_sport_defaults
           WHERE account_id = $1 ORDER BY sport_code`,
        ),
        q(
          `SELECT id, sport_id, home_name, away_name, home_score, away_score, home_sets, away_sets, sets,
                  status, created_at, updated_at
           FROM casual_games WHERE owner_account_id = $1 ORDER BY created_at`,
        ),
        q(
          `SELECT id, name, settings, created_at FROM casual_game_presets WHERE owner_account_id = $1 ORDER BY created_at`,
        ),
        q(
          `SELECT id, CASE WHEN sender_id = $1 THEN 'sent' ELSE 'received' END AS direction,
                  CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END AS other_account_id,
                  status, created_at, updated_at
           FROM casual_friend_requests WHERE sender_id = $1 OR recipient_id = $1 ORDER BY created_at`,
        ),
        q(`SELECT game_id, shared_at FROM casual_game_shares WHERE recipient_id = $1 ORDER BY shared_at`),
        q(
          `SELECT s.id, s.created_at, s.last_seen_at, s.idle_expires_at, s.absolute_expires_at, s.revoked_at,
                  s.provider_issuer, a.assurance_level, a.authentication_methods, a.authenticated_at
           FROM identity_sessions s LEFT JOIN identity_session_assurance a ON a.session_id = s.id
           WHERE s.account_id = $1 ORDER BY s.created_at DESC LIMIT 500`,
        ),
        q(
          `SELECT s.organisation_id, s.tier, s.status, s.provider_customer_id, s.provider_subscription_id,
                  s.current_period_start, s.current_period_end, s.created_at
           FROM organisation_subscriptions s
           WHERE s.organisation_id IN (${ownedOrganisationIds})`,
        ),
        q(
          `SELECT g.organisation_id, g.competition_id, g.tier, g.feature, g.source, g.quantity, g.expires_at,
                  g.created_at
           FROM entitlement_grants g
           WHERE g.organisation_id IN (${ownedOrganisationIds}) ORDER BY g.created_at`,
        ),
        q(
          `SELECT u.organisation_id, u.metric, u.quantity, u.created_at
           FROM billing_usage_events u
           WHERE u.organisation_id IN (${ownedOrganisationIds}) ORDER BY u.created_at DESC LIMIT 1000`,
        ),
        q(
          `SELECT r.organisation_id, r.event_type, r.status, r.created_at
           FROM billing_webhook_receipts r
           WHERE r.organisation_id IN (${ownedOrganisationIds}) ORDER BY r.created_at DESC LIMIT 1000`,
        ),
        q(
          `SELECT c.id, c.organisation_id, c.name, c.slug, c.status, c.starts_on, c.ends_on, c.created_at
           FROM competitions c WHERE c.created_by = $1 ORDER BY c.created_at`,
        ),
        q(
          `SELECT id, occurred_at, request_id, organisation_id, action, target_type, target_id
           FROM audit_events WHERE actor_account_id = $1 ORDER BY occurred_at DESC LIMIT 5000`,
        ),
      ]);

      await this.audit(tx, {
        requestId,
        accountId,
        action: "account.data_export_requested",
        afterState: { notifications: notifications.length, sessions: sessions.length },
      });

      return {
        format_version: 1,
        generated_at: new Date().toISOString(),
        subject_account_id: accountId,
        notes: [
          "Secrets such as session tokens, token hashes and provider session identifiers are never included.",
          "Other people appear only as opaque account ids. Audit rows are the append-only history of actions you performed.",
          "Competition data for competitions you created is available through each competition's own export.",
        ],
        account,
        sign_in_identities: providerIdentities,
        organisation_memberships: memberships,
        official_grants: officialGrants,
        platform_roles: platformRoles,
        notification_preferences: preferences,
        notifications,
        sport_defaults: sportDefaults,
        casual: {
          games: casualGames,
          presets: casualPresets,
          friend_requests: casualFriendRequests,
          games_shared_with_you: casualShares,
        },
        sessions,
        billing: {
          note: "Billing records for organisations where you are an active owner. Card details are held by the payment provider and are not included.",
          subscriptions: billingSubscriptions,
          entitlements: billingEntitlements,
          usage_events: billingUsage,
          webhook_receipts: billingReceipts,
        },
        competitions_created: competitions.map((competition) => ({
          ...competition,
          export_paths: [
            `/api/v1/competitions/${String(competition.id)}/exports/csv`,
            `/api/v1/competitions/${String(competition.id)}/exports/standings/csv`,
          ],
        })),
        audit_events_performed: auditEvents,
      };
    });
  }

  /**
   * PDPA deletion by anonymisation. Rows other records reference (competitions, audit history, results)
   * keep pointing at the same account id, but the id no longer identifies a person.
   */
  async deleteAccount(input: {
    accountId: string;
    confirmation: string;
    requestId: string;
  }): Promise<AccountDeletionResult> {
    if (input.confirmation.trim() !== accountDeletionConfirmationPhrase) {
      throw new ApiError(
        400,
        ErrorCode.VALIDATION_ERROR,
        `Type "${accountDeletionConfirmationPhrase}" exactly to confirm account deletion`,
      );
    }
    return this.transaction(async (tx) => {
      const q = (query: string, params: readonly unknown[] = [input.accountId]) => tx.unsafe<Row>(query, params);
      const locked = (await q(`SELECT id, status FROM accounts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`))[0];
      if (!locked) throw new ApiError(404, ErrorCode.NOT_FOUND, "Account not found");

      // Sole active owner of an organisation that has published/live competitions: refuse. There are
      // no invite or ownership-transfer routes yet, so the only way out is completing or archiving.
      const blocking = await q(
        `SELECT o.id, o.name
         FROM organisation_memberships m
         JOIN organisations o ON o.id = m.organisation_id
         WHERE m.account_id = $1 AND m.role = 'owner' AND m.status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM organisation_memberships x
             WHERE x.organisation_id = m.organisation_id AND x.role = 'owner' AND x.status = 'active'
               AND x.account_id <> $1)
           AND EXISTS (
             SELECT 1 FROM competitions c
             WHERE c.organisation_id = o.id AND c.status = ANY($2::text[]))
         ORDER BY o.name`,
        [input.accountId, liveCompetitionStatuses],
      );
      if (blocking.length > 0) {
        const names = blocking.map((row) => String(row.name)).join(", ");
        throw new ApiError(
          409,
          ErrorCode.LIFECYCLE_CONFLICT,
          `You are the only owner of ${names}, which has published or live competitions. ` +
            "Complete or archive those competitions first. Ownership transfer and owner invitations are not " +
            "available yet, so if you need the organisation to continue, contact the data protection officer.",
        );
      }

      const now = new Date();
      // Memberships: keep ownership where the organisation would otherwise have no owner (database
      // invariant); suspend every other membership so the anonymised account holds no live access.
      const suspended = await q(
        `UPDATE organisation_memberships m
         SET status = 'suspended', updated_at = $2
         WHERE m.account_id = $1 AND m.status <> 'suspended'
           AND NOT (
             m.role = 'owner' AND m.status = 'active' AND NOT EXISTS (
               SELECT 1 FROM organisation_memberships x
               WHERE x.organisation_id = m.organisation_id AND x.role = 'owner' AND x.status = 'active'
                 AND x.account_id <> $1))
         RETURNING m.id`,
        [input.accountId, now],
      );
      const retained = await q(`SELECT 1 FROM organisation_memberships WHERE account_id = $1 AND status = 'active'`);
      await q(`UPDATE official_grants SET revoked_at = $2 WHERE account_id = $1 AND revoked_at IS NULL`, [
        input.accountId,
        now,
      ]);

      const revoked = await q(
        `UPDATE identity_sessions
         SET revoked_at = COALESCE(revoked_at, $2), provider_session_id = NULL, provider_subject = NULL,
             provider_issuer = NULL
         WHERE account_id = $1
         RETURNING id`,
        [input.accountId, now],
      );
      // The provider link is what ties a returning sign-in to this account; removing it lets the same
      // person register a brand new account later.
      const providerLinks = await q(`DELETE FROM provider_identities WHERE account_id = $1 RETURNING id`);
      const notifications = await q(`DELETE FROM notifications WHERE account_id = $1 RETURNING id`);
      const preferences = await q(
        `DELETE FROM notification_preferences WHERE account_id = $1 RETURNING notification_type`,
      );
      const friends = await q(
        `DELETE FROM casual_friend_requests WHERE sender_id = $1 OR recipient_id = $1 RETURNING id`,
      );
      await q(`DELETE FROM casual_game_shares WHERE recipient_id = $1`);
      const presets = await q(`DELETE FROM casual_game_presets WHERE owner_account_id = $1 RETURNING id`);
      const defaults = await q(`DELETE FROM account_sport_defaults WHERE account_id = $1 RETURNING sport_code`);
      // Casual games the person scored become unclaimed; the retention job removes them on schedule.
      await q(`UPDATE casual_games SET owner_account_id = NULL WHERE owner_account_id = $1`);

      await q(
        `UPDATE accounts
         SET primary_email = 'deleted-' || id::text || '@invalid', display_name = 'Deleted user',
             status = 'deleted', email_verified_at = NULL, deleted_at = $2, updated_at = $2
         WHERE id = $1`,
        [input.accountId, now],
      );

      const result: AccountDeletionResult = {
        deleted_at: iso(now),
        revoked_sessions: revoked.length,
        removed: {
          notifications: notifications.length,
          notification_preferences: preferences.length,
          friend_requests: friends.length,
          presets: presets.length,
          sport_defaults: defaults.length,
          provider_links: providerLinks.length,
        },
        suspended_memberships: suspended.length,
        retained_memberships: retained.length,
      };
      await this.audit(tx, {
        requestId: input.requestId,
        accountId: input.accountId,
        action: "account.deleted",
        afterState: { status: "deleted", anonymised: true },
        metadata: { method: "anonymisation", ...result },
      });
      return result;
    });
  }
}
