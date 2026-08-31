import { SiteHeader, SiteFooter } from "@/components/foundation/SiteChrome";
import { messages } from "@matchday/ui";
import styles from "./PricingPage.module.css";

export const metadata = {
  title: messages.metadata.pricingTitle,
  description: messages.metadata.pricingDescription,
};

const TIERS = [
  {
    name: messages.pricing.starterName,
    tier: "free",
    price: "$0",
    period: messages.pricing.forever,
    description: messages.pricing.starterDescription,
    features: messages.pricing.freeFeatures,
    cta: messages.pricing.startFree,
    href: "/organiser",
  },
  {
    name: messages.pricing.eventPassName,
    tier: "event_pass",
    price: "$49",
    period: messages.pricing.perEvent,
    badge: messages.pricing.eventPassBadge,
    description: messages.pricing.eventPassDescription,
    features: messages.pricing.eventPassFeatures,
    cta: messages.pricing.getEventPass,
    href: "/organiser/checkout/event-pass",
  },
  {
    name: messages.pricing.proName,
    tier: "organiser_pro",
    price: "$99",
    period: messages.pricing.perMonth,
    badge: messages.pricing.proBadge,
    description: messages.pricing.proDescription,
    features: messages.pricing.proFeatures,
    cta: messages.pricing.subscribePro,
    href: "/organiser",
  },
];

export default function PricingPage() {
  return (
    <div className={styles.container}>
      <SiteHeader />
      <main className={styles.main}>
        <div className={styles.header}>
          <h1 className={styles.title}>{messages.pricing.title}</h1>
          <p className={styles.subtitle}>{messages.pricing.subtitle}</p>
        </div>

        <div className={styles.grid}>
          {TIERS.map((tier) => (
            <div key={tier.tier} className={`${styles.card} ${tier.badge ? styles.featured : ""}`}>
              {tier.badge && <div className={styles.cardBadge}>{tier.badge}</div>}
              <h2 className={styles.tierName}>{tier.name}</h2>
              <div className={styles.pricing}>
                <span className={styles.amount}>{tier.price}</span>
                <span className={styles.period}>/ {tier.period}</span>
              </div>
              <p className={styles.description}>{tier.description}</p>
              <ul className={styles.features}>
                {tier.features.map((feature, i) => (
                  <li key={i} className={styles.featureItem}>
                    <span className={styles.checkIcon}>✓</span>
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
              <a href={tier.href} className={styles.ctaButton}>
                {tier.cta}
              </a>
            </div>
          ))}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
