import "server-only";
import { cookies } from "next/headers";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { isRedesignRulesEnabled } from "@/lib/feature-flags.server";

/** Local and test builds only: this cookie previews the Rules page without changing the deployment flag. */
export const REDESIGN_RULES_PREVIEW_COOKIE = "matchday-redesign-rules";

/**
 * Redesign Phase 4 Rules page switch. Production follows the `organiser.redesign-p4-rules` flag (default off).
 * Demo fixture builds also honour the preview cookie, so browser tests can cover both pages against one server.
 */
export async function redesignRulesEnabled(): Promise<boolean> {
  if (await isRedesignRulesEnabled()) return true;
  if (!demoFixturesEnabled()) return false;
  try {
    return (await cookies()).get(REDESIGN_RULES_PREVIEW_COOKIE)?.value === "1";
  } catch {
    // Outside a request (e.g. a static render) there is no cookie to read.
    return false;
  }
}
