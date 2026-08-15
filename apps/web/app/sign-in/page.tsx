import type { Metadata } from "next";
import { translate as t } from "@matchday/ui";
import { SystemStatePage } from "@/components/foundation/SystemStatePage";

export const metadata: Metadata = {
  title: t("prototype.bfd402b2f6f3"),
  robots: { index: false, follow: false },
};

export default async function SignInPage({ searchParams }: Readonly<{ searchParams: Promise<{ reason?: string }> }>) {
  const { reason } = await searchParams;
  const stepUpRequired = reason === "step-up";

  return (
    <SystemStatePage
      kind="forbidden"
      code={stepUpRequired ? "VERIFY" : "ORGANISER"}
      title={stepUpRequired ? t("prototype.ee7db0c90f4c") : t("prototype.dca582f9f5bb")}
      body={stepUpRequired ? t("prototype.2bb79c0209d5") : t("prototype.d4eb4782174e")}
      detail={stepUpRequired ? t("prototype.e6a8b1ba653e") : t("prototype.7183e990a8f5")}
      actionLabel={stepUpRequired ? t("prototype.7c00476e6d90") : t("prototype.bfd402b2f6f3")}
      actionHref="/api/v1/identity/authorize"
      actionNavigation="document"
    />
  );
}
