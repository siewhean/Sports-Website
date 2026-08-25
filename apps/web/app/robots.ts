import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/competitions", "/pricing", "/privacy", "/terms", "/cookies"],
        disallow: ["/api/", "/organiser/", "/score/", "/internal/"],
      },
    ],
    sitemap: "https://matchday.example/sitemap.xml",
  };
}
