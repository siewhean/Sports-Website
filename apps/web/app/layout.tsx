import type { Metadata } from "next";
import { headers } from "next/headers";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { ConsentManager } from "@/components/foundation/ConsentManager";
import { ServiceWorkerRegistration } from "@/components/foundation/ServiceWorkerRegistration";
import { messages } from "@matchday/ui";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://matchday.example"),
  title: {
    default: messages.metadata.defaultTitle,
    template: messages.metadata.titleTemplate,
  },
  description: messages.metadata.description,
  manifest: "/manifest.webmanifest",
  openGraph: {
    title: messages.metadata.defaultTitle,
    description: messages.metadata.homeOpenGraphDescription,
    siteName: messages.brand.name,
  },
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Reading the proxy-provided nonce opts the route into request-time rendering,
  // allowing Next to apply the nonce to every framework bootstrap script.
  await headers();
  return (
    <html lang="en">
      <body className={`${GeistSans.variable} ${GeistMono.variable}`}>
        {children}
        <ConsentManager />
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
