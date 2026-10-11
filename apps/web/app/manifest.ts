import type { MetadataRoute } from "next";
import { messages, opaqueId } from "@matchday/ui";

// Brand tokens from globals.css: --ink (graphite) for browser chrome, dark-theme --canvas for the splash screen.
const THEME_COLOR = "#171918";
const BACKGROUND_COLOR = "#111513";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: messages.metadata.manifestName,
    short_name: messages.metadata.manifestShortName,
    description: messages.metadata.manifestDescription,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: BACKGROUND_COLOR,
    theme_color: THEME_COLOR,
    icons: [
      { src: "/icons/icon-192.png", sizes: opaqueId("192x192"), type: "image/png", purpose: opaqueId("any") },
      { src: "/icons/icon-512.png", sizes: opaqueId("512x512"), type: "image/png", purpose: opaqueId("any") },
      { src: "/icons/maskable-512.png", sizes: opaqueId("512x512"), type: "image/png", purpose: opaqueId("maskable") },
    ],
  };
}
