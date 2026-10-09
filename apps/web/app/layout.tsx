import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { ConsentManager } from "@/components/foundation/ConsentManager";
import { ServiceWorkerRegistration } from "@/components/foundation/ServiceWorkerRegistration";
import { resolveSeoOrigin } from "@/lib/public-origin";
import { messages, opaqueId } from "@matchday/ui";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const origin = resolveSeoOrigin(await headers());
  return {
    ...(origin ? { metadataBase: new URL(origin) } : {}),
    title: {
      default: messages.metadata.defaultTitle,
      template: messages.metadata.titleTemplate,
    },
    description: messages.metadata.description,
    applicationName: messages.brand.name,
    manifest: "/manifest.webmanifest",
    // Canonical and og:url are set per page: a root value would be inherited by every child route.
    openGraph: {
      title: messages.metadata.defaultTitle,
      description: messages.metadata.homeOpenGraphDescription,
      siteName: messages.brand.name,
      type: "website",
      locale: opaqueId("en_SG"),
    },
    twitter: { card: opaqueId("summary_large_image") },
  };
}

export const viewport: Viewport = {
  themeColor: "#171918",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Reading the proxy-provided nonce opts every route into request-time rendering, allowing Next to apply the
  // per-request nonce to framework bootstrap and inline RSC payload scripts (see the CSP note in proxy.ts).
  await headers();
  // The next/font variables live on <html> so the :root --font-sans / --font-mono tokens can resolve them.
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        {children}
        <ConsentManager />
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
