import type { MetadataRoute } from "next";
import { messages } from "@matchday/ui";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: messages.metadata.manifestName,
    short_name: messages.metadata.manifestShortName,
    description: messages.metadata.manifestDescription,
    start_url: "/",
    display: "standalone",
    background_color: "#f7f6f0",
    theme_color: "#171918",
  };
}
