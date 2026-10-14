# Upstash Redis Cleanup & Decommissioning

**Status:** Pending owner action. The codebase holds no Upstash references; the console deletion below has not yet been confirmed (see `docs/qa/track-r5.md`).

Matchday uses an internal Redis 8.10 container on the OCI VM (`infra/oci/compose.prod.yaml`) for BullMQ queue management, job dispatch, and rate limiting. The early external Upstash Redis database is completely unused and has no connections or credentials referenced in the codebase or production environment.

## Owner Deletion Procedure

To eliminate stray costs, unmonitored endpoints, and credential exposure:

1. **Sign in** to [Upstash Console](https://console.upstash.com).
2. **Select Database**: Navigate to the Redis databases listing and find the legacy Matchday database.
3. **Verify Zero Activity**:
   - Check the **Metrics** tab: confirm 0 requests/sec, 0 connected clients, and 0 memory usage over the past 30 days.
4. **Delete Database**:
   - Go to **Details** > **Delete Database**.
   - Type the confirmation phrase and confirm deletion.
5. **Revoke Keys**: Ensure any local `.env` or past password managers have deleted the associated Upstash REST tokens or passwords.
