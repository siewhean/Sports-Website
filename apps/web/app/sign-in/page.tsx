import type { Metadata } from "next";
import { SystemStatePage } from "@/components/foundation/SystemStatePage";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

export default async function SignInPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ reason?: string }> }>) {
  const { reason } = await searchParams;
  const stepUpRequired = reason === "step-up";

  return (
    <SystemStatePage
      kind="forbidden"
      code={stepUpRequired ? "VERIFY" : "ORGANISER"}
      title={stepUpRequired ? "Verify your sign-in to continue" : "Sign in to manage competitions"}
      body={
        stepUpRequired
          ? "This organiser session is valid, but this workspace requires stronger authentication before you continue."
          : "Your organiser workspace is private. Sign in before creating, scheduling or scoring a competition."
      }
      detail={
        stepUpRequired
          ? "Continue through the identity provider. MATCHDAY will accept access only after the configured verification requirement is satisfied."
          : "After authentication, MATCHDAY will return you to the organiser workspace."
      }
      actionLabel={stepUpRequired ? "Verify sign-in" : "Sign in"}
      actionHref="/api/v1/identity/authorize"
      actionNavigation="document"
    />
  );
}
