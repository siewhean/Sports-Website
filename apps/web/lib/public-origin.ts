import { configuredPublicOrigin, requestForwardedOrigin } from "@/lib/phase3-origin";

/*
 * Canonical origin for SEO output only (metadataBase, canonical links, sitemap, robots, JSON-LD, OG URLs).
 *
 * This is deliberately separate from the fail-closed origin checks in lib/phase3-origin.ts that guard mutations:
 * those still require MATCHDAY_PUBLIC_ORIGIN (or loopback) and are not loosened here. A wrong SEO origin only
 * produces a wrong link; a wrong mutation origin would be a CSRF hole.
 *
 * Fallback chain: MATCHDAY_PUBLIC_ORIGIN → VERCEL_PROJECT_PRODUCTION_URL (Vercel system env, hostname only) →
 * the request's own origin (HTTPS, or loopback HTTP for local development).
 */
type Environment = Readonly<Record<string, string | undefined>>;

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function vercelProductionOrigin(value: string | undefined): string | null {
  const host = value?.trim();
  if (!host || /[\s/\\@?#]/u.test(host)) return null;
  return configuredPublicOrigin(`https://${host}`);
}

/** The SEO origin derivable from configuration alone (safe for cached / build-time output). */
export function seoOriginFromEnv(env: Environment = process.env): string | null {
  return (
    configuredPublicOrigin(env.MATCHDAY_PUBLIC_ORIGIN) ?? vercelProductionOrigin(env.VERCEL_PROJECT_PRODUCTION_URL)
  );
}

/** Last-resort SEO origin from request headers: HTTPS only, or HTTP on loopback. */
export function seoOriginFromRequest(requestHeaders: Headers): string | null {
  const origin = requestForwardedOrigin(requestHeaders);
  if (!origin) return null;
  const url = new URL(origin);
  if (url.protocol === "https:") return url.origin;
  return LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase()) ? url.origin : null;
}

export function resolveSeoOrigin(requestHeaders: Headers | null, env: Environment = process.env): string | null {
  return seoOriginFromEnv(env) ?? (requestHeaders ? seoOriginFromRequest(requestHeaders) : null);
}
