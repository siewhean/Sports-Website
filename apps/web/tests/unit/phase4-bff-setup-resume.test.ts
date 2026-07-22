import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../../lib/phase4-bff-setup-resume";

const origin = "https://matchday.test";
const competitionId = "4dc85811-e715-40f4-8609-2523f7516e5a";

function request(referrer: string): NextRequest {
  return new NextRequest(`${origin}/api/phase4/competitions/${competitionId}/setup-draft/resume`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "matchday.test", origin, referer: referrer },
    body: JSON.stringify({ idempotency_key: "resume-draft-0001" }),
  });
}

beforeEach(() => {
  process.env.APP_ENV = "test";
  process.env.MATCHDAY_PHASE2_DATA_MODE = "demo";
  process.env.MATCHDAY_ALLOW_DEMO_FIXTURES = "1";
});

afterEach(() => {
  delete process.env.APP_ENV;
  delete process.env.MATCHDAY_PHASE2_DATA_MODE;
  delete process.env.MATCHDAY_ALLOW_DEMO_FIXTURES;
});

describe("Assisted Setup resume BFF demo isolation", () => {
  it("preserves a validated same-origin preview step", async () => {
    const response = await POST(request(`${origin}/organiser/competitions/${competitionId}/setup?step=basics`), {
      params: Promise.resolve({ competitionId }),
    });
    const document = (await response.json()) as { current_step: string };

    expect(response.status).toBe(200);
    expect(document.current_step).toBe("basics");
  });

  it("ignores cross-origin preview input", async () => {
    const response = await POST(request("https://attacker.test/setup?step=review_publish"), {
      params: Promise.resolve({ competitionId }),
    });
    const document = (await response.json()) as { current_step: string };

    expect(response.status).toBe(200);
    expect(document.current_step).toBe("capacity");
  });
});
