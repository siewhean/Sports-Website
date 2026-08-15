import type { Metadata } from "next";
import { ArrowRight } from "@phosphor-icons/react/dist/ssr";
import { translate as t } from "@matchday/ui";
import { BrandLink } from "@/components/foundation/Primitives";
import styles from "./SignInPage.module.css";

export const metadata: Metadata = {
  title: t("prototype.bfd402b2f6f3"),
  robots: { index: false, follow: false },
};

export default async function SignInPage({ searchParams }: Readonly<{ searchParams: Promise<{ reason?: string }> }>) {
  const { reason } = await searchParams;
  const stepUpRequired = reason === "step-up";

  return (
    <main className={styles.page} id="main-content">
      <header className={styles.header}>
        <BrandLink />
      </header>
      <section className={styles.content} aria-labelledby="sign-in-title">
        <h1 id="sign-in-title">{stepUpRequired ? t("prototype.ee7db0c90f4c") : t("prototype.dca582f9f5bb")}</h1>
        <p className={styles.lede}>{stepUpRequired ? t("prototype.2bb79c0209d5") : t("prototype.d4eb4782174e")}</p>
        <p className={styles.detail}>{stepUpRequired ? t("prototype.e6a8b1ba653e") : t("prototype.7183e990a8f5")}</p>
        <a className={styles.action} href="/api/v1/identity/authorize">
          <span>{stepUpRequired ? t("prototype.7c00476e6d90") : t("prototype.bfd402b2f6f3")}</span>
          <ArrowRight aria-hidden="true" />
        </a>
      </section>
    </main>
  );
}
