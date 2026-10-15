# Stripe Live Mode Operations Runbook (Not Yet Executed)

**Status:** Not Yet Executed / Pending Owner Execution  
**Date:** 15 October 2026  
**Track:** R7.3 (Commercial, legal and identity readiness)  
**Applies to:** Production billing, Stripe dashboard, webhook verification, ledger reconciliation

---

## 1. Overview

This runbook specifies the configuration, activation, and operational reconciliation required to switch Stripe from test mode to live mode, enabling lawful payment processing for Matchday products (Event Pass and Organiser Pro subscriptions).

> [!WARNING]
> **Execution Status: Not Yet Executed.**  
> Live Stripe keys have not been configured, and no live purchase or refund has been performed. This runbook documents the required owner procedure.

Completion of this runbook is required for Checkpoint **CP7 Item 2**:

> _"One live purchase and refund completed and reconciled in the billing ledger."_

---

## 2. Live Account & Products Configuration

### 2.1 Singapore Entity & Payout Setup

1. In the [Stripe Dashboard](https://dashboard.stripe.com):
   - Confirm legal entity details match your ACRA-registered business entity and registered office address once established.
   - Complete ACRA business verification and link the SGD corporate bank account.
2. Confirm default presentment and settlement currency is set to **SGD** (Singapore Dollars).

### 2.2 Live Product Catalog & Price IDs

Create products in Stripe Dashboard (**Product catalog > Add product**):

| Product               | Billing Model       | Tax Code                | Environment Variable            | Example Live Price ID      |
| --------------------- | ------------------- | ----------------------- | ------------------------------- | -------------------------- |
| **Event Pass**        | One-time            | Standard Digital Goods  | `STRIPE_PRICE_ID_EVENT_PASS`    | `price_1Nx...live...event` |
| **Organiser Pro**     | Recurring (Monthly) | SaaS / Digital Services | `STRIPE_PRICE_ID_ORGANISER_PRO` | `price_1Nx...live...pro`   |
| **AI Actions Top-Up** | One-time            | Digital Credits         | `STRIPE_PRICE_ID_AI_TOPUP`      | `price_1Nx...live...ai`    |

### 2.3 Restricted Live API Key Creation

Do not use the root live secret key. Create a Restricted API Key (**Developers > API keys > Restricted keys**):

- **Name:** `matchday-prod-backend`
- **Permissions:**
  - `Checkout Sessions`: Write
  - `Customers`: Write
  - `Subscriptions`: Read and Write
  - `Webhook Endpoints`: Read
- Set key in production secret vault as `STRIPE_SECRET_KEY` (`rk_live_...`).

---

## 3. Live Webhook Endpoint Provisioning

1. Navigate to **Developers > Webhooks > Add destination**:
   - **Endpoint URL:** `https://matchday.poladex.shop/api/v1/billing/webhook`
   - **Version:** Latest Stripe API version (2024-06-20 or newer)
   - **Select events to send:**
     - `checkout.session.completed`
     - `checkout.session.async_payment_succeeded`
     - `checkout.session.async_payment_failed`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`
2. Reveal the **Signing secret** (`whsec_...`).
3. Store the signing secret in production environment as `STRIPE_WEBHOOK_SECRET`.

---

## 4. Live Verification & Refund Reconciliation Procedure

Follow these steps to safely complete and reconcile the required live test transaction:

### Step 1: Pre-flight Verification

On the production host (`/opt/matchday/oci-src`), validate the live environment file before the purchase:

```bash
node scripts/validate-production-config.mjs infra/oci/.env.prod
```

The validator must pass with the live `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and live price IDs in place. Also confirm the configured SMTP provider (`SMTP_HOST`, `SMTP_FROM`) is configured, since all transactional email is sent through that provider.

### Step 2: Live Test Purchase Execution

1. As an operator or designated test organizer, sign in to `https://matchday.poladex.shop`.
2. Navigate to an active test competition (e.g., `Live Commercial Probe Tournament`).
3. Select **Upgrade Competition > Event Pass**.
4. Complete checkout on the Stripe-hosted Checkout Session using a real corporate credit/debit card.
5. Confirm browser redirect lands on the success page: `https://matchday.poladex.shop/organise/<competition-id>?checkout=success`.

### Step 3: Webhook Delivery & Ledger Verification

Verify database ledger entries within PostgreSQL on OCI production:

```sql
-- 1. Verify receipt of processed Stripe webhook event
SELECT id, provider_event_id, event_type, status, created_at, processed_at
FROM billing_webhook_receipts
WHERE event_type = 'checkout.session.completed'
ORDER BY created_at DESC
LIMIT 1;

-- 2. Verify entitlement grant created for competition
SELECT id, organisation_id, competition_id, tier, feature, source, quantity, expires_at
FROM entitlement_grants
WHERE source = 'purchase'
ORDER BY created_at DESC
LIMIT 1;
```

**Acceptance criteria:**

- `billing_webhook_receipts.status` is `'processed'`.
- `entitlement_grants.feature` is `'unlimited_entries'`.
- `payload` JSON contains no unmasked PAN or sensitive cardholder details.

### Step 4: Issue Immediate Full Refund

1. Immediately open the Stripe Dashboard > **Payments**.
2. Select the live test payment and click **Refund**.
3. Select **Reason:** "Duplicate / Test Transaction".
4. Submit the refund.

### Step 5: Ledger Reconciliation After Refund

Verify that the refund is recorded and reflected in Matchday:

```sql
-- Verify billing ledger consistency
SELECT * FROM billing_webhook_receipts
WHERE payload->'data'->'object'->>'payment_intent' = '<PAYMENT_INTENT_ID>'
   OR payload->'data'->'object'->>'id' = '<SESSION_ID>';
```

Record the Stripe Payment Intent ID and Refund ID in the launch verification receipt.

---

## 5. Security & Privacy Safeguards (PDPA Compliance)

- **No Card Data Storage:** Matchday never receives, processes, or stores payment card numbers. Card inputs are hosted inside Stripe Elements / Checkout Sessions.
- **Webhook Sanitization:** `billing-routes.ts` and `entitlement-runtime.ts` prune customer address and personal metadata before persisting event projections.
- **Receipt Retention:** Webhook receipts in `billing_webhook_receipts` are automatically purged after 400 days in accordance with the PDPA retention schedule (`PDPA_RETENTION_BILLING_RECEIPT_DAYS=400`).
