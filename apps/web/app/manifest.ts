import type { MetadataRoute } from "next";
import { designTokens, messages, opaqueId } from "@matchday/ui";

// Dark is the default theme: browser chrome and splash screen both use the dark canvas.
const THEME_COLOR = designTokens.themeColor.dark;
const BACKGROUND_COLOR = designTokens.themeColor.dark;

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
