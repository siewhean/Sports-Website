import { describe, expect, it } from "vitest";
import { parseEventPassCheckoutUrl } from "../../lib/event-pass-checkout";

const target = {
  organisationId: "11111111-1111-4111-8111-111111111111",
  competitionId: "22222222-2222-4222-8222-222222222222",
};

describe("Event Pass checkout response guard", () => {
  it("accepts only the Stripe checkout for the selected organisation and competition", () => {
    expect(
      parseEventPassCheckoutUrl(
        {
          organisation_id: target.organisationId,
          competition_id: target.competitionId,
          tier: "event_pass",
          purchase_type: "plan",
          checkout_url: "https://checkout.stripe.com/c/pay/cs_test_123",
        },
        target,
      ),
    ).toBe("https://checkout.stripe.com/c/pay/cs_test_123");
  });

  it("rejects a sibling competition or non-Stripe destination", () => {
    expect(
      parseEventPassCheckoutUrl(
        {
          organisation_id: target.organisationId,
          competition_id: "33333333-3333-4333-8333-333333333333",
          tier: "event_pass",
          purchase_type: "plan",
          checkout_url: "https://checkout.stripe.com/c/pay/cs_test_123",
        },
        target,
      ),
    ).toBeNull();

    expect(
      parseEventPassCheckoutUrl(
        {
          organisation_id: target.organisationId,
          competition_id: target.competitionId,
          tier: "event_pass",
          purchase_type: "plan",
          checkout_url: "https://example.com/not-stripe",
        },
        target,
      ),
    ).toBeNull();
  });
});
