import type { Metadata } from "next";
import { ArrowRight } from "@phosphor-icons/react/dist/ssr";
import { BrandLink } from "@/components/foundation/Primitives";
import styles from "./SignInPage.module.css";

export const metadata: Metadata = {
  title: "Sign in",
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
        <h1 id="sign-in-title">{stepUpRequired ? "Verify your sign-in to continue" : "Sign in to manage competitions"}</h1>
        <p className={styles.lede}>
          {stepUpRequired
            ? "This organiser session is valid, but this workspace requires stronger authentication before you continue."
            : "Your organiser workspace is private. Sign in before creating, scheduling or scoring a competition."}
        </p>
        <p className={styles.detail}>
          {stepUpRequired
            ? "Continue through the identity provider. MATCHDAY will accept access only after the configured verification requirement is satisfied."
            : "After authentication, MATCHDAY will return you to the organiser workspace."}
        </p>
        <a className={styles.action} href="/api/v1/identity/authorize">
          <span>{stepUpRequired ? "Verify sign-in" : "Sign in"}</span>
          <ArrowRight aria-hidden="true" />
        </a>
      </section>
    </main>
  );
}
