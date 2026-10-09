import "server-only";
import { headers } from "next/headers";
import { resolveSeoOrigin, seoOriginFromEnv } from "@/lib/public-origin";

/**
 * SEO origin for the current render. Configured origins never touch request headers, so cached routes (sitemap,
 * robots) stay cacheable whenever MATCHDAY_PUBLIC_ORIGIN or VERCEL_PROJECT_PRODUCTION_URL is set; only the
 * unconfigured fallback reads the request (which makes that render dynamic).
 */
export async function seoOrigin(): Promise<string | null> {
  const configured = seoOriginFromEnv();
  if (configured) return configured;
  try {
    return resolveSeoOrigin(await headers());
  } catch {
    return null;
  }
}
