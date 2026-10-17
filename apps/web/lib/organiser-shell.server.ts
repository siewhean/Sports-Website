import "server-only";
import { cookies } from "next/headers";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { isOrganiserRedesignShellEnabled } from "@/lib/feature-flags.server";

/** Local and test builds only: this cookie previews the redesign shell without changing the deployment flag. */
export const REDESIGN_SHELL_PREVIEW_COOKIE = "matchday-redesign-shell";

/**
 * Redesign Phase 2 shell switch. Production follows the `organiser.redesign-shell` flag (default off). Demo
 * fixture builds also honour the preview cookie, so browser tests can cover both shells against one server.
 */
export async function organiserRedesignShellEnabled(): Promise<boolean> {
  if (await isOrganiserRedesignShellEnabled()) return true;
  if (!demoFixturesEnabled()) return false;
  try {
    return (await cookies()).get(REDESIGN_SHELL_PREVIEW_COOKIE)?.value === "1";
  } catch {
    // Outside a request (e.g. a static render) there is no cookie to read.
    return false;
  }
}
