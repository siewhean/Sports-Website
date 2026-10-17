import "server-only";
import { cookies } from "next/headers";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { isOrganiserRedesignP3StartEnabled } from "@/lib/feature-flags.server";

/** Local and test builds only: this cookie previews the redesign guided start without changing the deployment flag. */
export const REDESIGN_P3_START_PREVIEW_COOKIE = "matchday-redesign-p3-start";

/**
 * Redesign Phase 3 guided start switch. Production follows the `organiser.redesign-p3-start` flag (default off).
 * Demo fixture builds also honour the preview cookie, so browser tests can cover both flows against one server.
 */
export async function organiserRedesignP3StartEnabled(): Promise<boolean> {
  if (await isOrganiserRedesignP3StartEnabled()) return true;
  if (!demoFixturesEnabled()) return false;
  try {
    return (await cookies()).get(REDESIGN_P3_START_PREVIEW_COOKIE)?.value === "1";
  } catch {
    return false;
  }
}
