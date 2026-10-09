import type { MetadataRoute } from "next";
import { seoOrigin } from "@/lib/public-origin.server";

/** Signed-in, operational and transactional surfaces: never useful in search results. */
const ROBOTS_DISALLOW = [
  "/api/",
  "/organiser",
  "/score",
  "/official",
  "/internal",
  "/notifications",
  "/onboarding",
  "/setup",
  "/sign-in",
  "/format",
  "/play/",
  "/forbidden",
  "/maintenance",
  "/offline",
] as const;

export default async function robots(): Promise<MetadataRoute.Robots> {
  const origin = await seoOrigin();
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [...ROBOTS_DISALLOW],
      },
    ],
    ...(origin ? { sitemap: `${origin}/sitemap.xml` } : {}),
  };
}
