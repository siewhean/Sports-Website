import type { Metadata } from "next";
import { SystemStatePage } from "@/components/foundation/SystemStatePage";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

export default function SignInPage() {
  return (
    <SystemStatePage
      kind="forbidden"
      code="ORGANISER"
      title="Sign in to manage competitions"
      body="Your organiser workspace is private. Sign in before creating, scheduling or scoring a competition."
      detail="After authentication, MATCHDAY will return you to the organiser workspace."
      actionLabel="Sign in"
      actionHref="/api/v1/identity/authorize"
      actionNavigation="document"
    />
  );
}
