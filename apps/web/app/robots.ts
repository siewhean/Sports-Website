import type { MetadataRoute } from "next";
import { configuredPublicOrigin } from "@/lib/phase3-origin";

export default function robots(): MetadataRoute.Robots {
  const origin = configuredPublicOrigin(process.env.MATCHDAY_PUBLIC_ORIGIN);
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/competitions", "/pricing", "/privacy", "/terms", "/cookies", "/support", "/notifications"],
        disallow: ["/api/", "/organiser/", "/score/", "/internal/"],
      },
    ],
    ...(origin ? { sitemap: `${origin}/sitemap.xml` } : {}),
  };
}
