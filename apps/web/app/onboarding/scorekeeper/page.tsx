import Link from "next/link";
import { messages } from "@matchday/ui";
import { AncillaryPage } from "@/components/ancillary/AncillaryPage";
import styles from "./page.module.css";

export const metadata = {
  title: `${messages.onboarding.title} · ${messages.brand.name}`,
  description: messages.onboarding.subtitle,
};

export default function ScorekeeperOnboardingPage() {
  const steps = [
    { title: messages.onboarding.step1Title, body: messages.onboarding.step1Body },
    { title: messages.onboarding.step2Title, body: messages.onboarding.step2Body },
    { title: messages.onboarding.step3Title, body: messages.onboarding.step3Body },
    { title: messages.onboarding.step4Title, body: messages.onboarding.step4Body },
  ];

  return (
    <AncillaryPage title={messages.onboarding.title} intro={messages.onboarding.subtitle} narrow>
      <ol className={styles.steps}>
        {steps.map((step, index) => (
          <li key={step.title} className={styles.step}>
            <span className={styles.number} aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            <div>
              <h2>{step.title}</h2>
              <p>{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <Link href="/score" className={styles.cta}>
        {messages.onboarding.ctaStartScoring}
      </Link>
    </AncillaryPage>
  );
}
