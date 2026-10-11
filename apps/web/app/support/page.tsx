import { ArrowUpRight, CaretDown } from "@phosphor-icons/react/dist/ssr";
import { AncillaryPage } from "@/components/ancillary/AncillaryPage";
import { messages } from "@matchday/ui";
import styles from "./SupportPage.module.css";

export const metadata = {
  title: messages.support.title,
  description: messages.support.subtitle,
  alternates: { canonical: "/support" },
};

export default function SupportPage() {
  return (
    <AncillaryPage title={messages.support.title} intro={messages.support.subtitle} narrow>
      <div className={styles.sections}>
        <section aria-labelledby="support-faq-title">
          <h2 id="support-faq-title" className={styles.sectionTitle}>
            {messages.support.faqTitle}
          </h2>
          <div className={styles.faqs}>
            {messages.support.faqs.map((faq) => (
              <details key={faq.question} className={styles.faq}>
                <summary>
                  <span>{faq.question}</span>
                  <CaretDown aria-hidden="true" />
                </summary>
                <p>{faq.answer}</p>
              </details>
            ))}
          </div>
        </section>
        <section className={styles.contact} aria-labelledby="support-contact-title">
          <h2 id="support-contact-title">{messages.support.contactTitle}</h2>
          <p>{messages.support.contactBody}</p>
          <a href={`mailto:${messages.support.contactEmail}`}>
            {messages.support.contactEmail}
            <ArrowUpRight aria-hidden="true" />
          </a>
        </section>
      </div>
    </AncillaryPage>
  );
}
