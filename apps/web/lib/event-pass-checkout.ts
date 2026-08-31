export type EventPassCheckoutTarget = Readonly<{
  organisationId: string;
  competitionId: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function parseEventPassCheckoutUrl(value: unknown, target: EventPassCheckoutTarget): string | null {
  if (!isRecord(value)) return null;
  if (
    value.organisation_id !== target.organisationId ||
    value.competition_id !== target.competitionId ||
    value.tier !== "event_pass" ||
    value.purchase_type !== "plan" ||
    typeof value.checkout_url !== "string"
  ) {
    return null;
  }
  try {
    const checkout = new URL(value.checkout_url);
    return checkout.protocol === "https:" && checkout.hostname === "checkout.stripe.com" ? checkout.toString() : null;
  } catch {
    return null;
  }
}
