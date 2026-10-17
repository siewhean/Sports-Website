import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { ConsentManager } from "@/components/foundation/ConsentManager";
import { ServiceWorkerRegistration } from "@/components/foundation/ServiceWorkerRegistration";
import { resolveSeoOrigin } from "@/lib/public-origin";
import { messages, opaqueId } from "@matchday/ui";
import { DEFAULT_THEME, themeBootstrapScript, themeColorFor } from "@/lib/theme";
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

// Dark is the default theme; the pre-paint script in <head> retargets this meta for a saved Light/Same-as-device choice.
export const viewport: Viewport = {
  themeColor: themeColorFor(DEFAULT_THEME),
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Reading the proxy-provided nonce opts every route into request-time rendering, allowing Next to apply the
  // per-request nonce to framework bootstrap and inline RSC payload scripts (see the CSP note in proxy.ts).
  const nonce = (await headers()).get(opaqueId("x-nonce")) ?? undefined;
  // The next/font variables live on <html> so the :root --font-sans / --font-mono tokens can resolve them.
  // data-theme is always the default on the server (public documents are identical for every visitor); the
  // blocking script applies a saved choice before first paint, hence suppressHydrationWarning on <html>.
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      data-theme={DEFAULT_THEME}
      suppressHydrationWarning
    >
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeBootstrapScript() }} />
      </head>
      <body>
        {children}
        <ConsentManager />
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
