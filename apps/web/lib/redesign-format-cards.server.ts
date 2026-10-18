import "server-only";
import { cookies } from "next/headers";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { isRedesignP5CardsEnabled } from "@/lib/feature-flags.server";

/** Local and test builds only: this cookie previews the format cards without changing the deployment flag. */
export const REDESIGN_P5_CARDS_PREVIEW_COOKIE = "matchday-redesign-p5-cards";

/**
 * Redesign Phase 5 format cards switch. Production follows the `organiser.redesign-p5-cards` flag (default off).
 * Demo fixture builds also honour the preview cookie, so browser tests can cover both pages against one server.
 */
export async function redesignFormatCardsEnabled(): Promise<boolean> {
  if (await isRedesignP5CardsEnabled()) return true;
  if (!demoFixturesEnabled()) return false;
  try {
    return (await cookies()).get(REDESIGN_P5_CARDS_PREVIEW_COOKIE)?.value === "1";
  } catch {
    // Outside a request (e.g. a static render) there is no cookie to read.
    return false;
  }
}
