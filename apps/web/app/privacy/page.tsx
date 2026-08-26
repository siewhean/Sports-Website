import { LegalPage } from "@/components/foundation/LegalPage";
import { messages } from "@matchday/ui";

const updatedOn = "26 August 2026";

export default function PrivacyPage() {
  return (
    <LegalPage title={messages.legal.privacyTitle}>
      <p>Last updated: {updatedOn}</p>

      <section>
        <h2>Information Matchday processes</h2>
        <p>
          Matchday processes account and organisation information, competition setup and entry data, schedules, scoring
          and results, access and audit records, notification preferences, support/admin actions, and technical records
          needed to operate and secure the service. Billing records may include provider customer, subscription, event,
          and transaction references; payment-card details are handled by the configured payment provider rather than
          stored as Matchday competition data.
        </p>
      </section>

      <section>
        <h2>Why the information is used</h2>
        <p>
          Information is used to authenticate users, enforce permissions and entitlements, run competitions, calculate
          standings and advancement, publish organiser-approved information, deliver notifications, process billing,
          investigate support or security events, maintain audit history, and improve the reliability of the service.
        </p>
      </section>

      <section>
        <h2>Public competition information</h2>
        <p>
          Competition names, schedules, participants, standings, brackets, results, sponsor or branding information, and
          similar event content may become publicly accessible when an authorised organiser publishes them. Draft data
          is not intended for the public surface. Organisers should avoid placing unnecessary sensitive personal data in
          fields that may later be published.
        </p>
      </section>

      <section>
        <h2>Service providers and disclosures</h2>
        <p>
          Matchday may send the minimum information needed to infrastructure, identity, email, payment, observability,
          and other configured service providers that support the requested feature. Information may also be disclosed
          when required to protect the service, users, or others, or to comply with applicable legal obligations.
        </p>
      </section>

      <section>
        <h2>Retention and deletion</h2>
        <p>
          Competition and account records are retained while needed to provide the service, preserve organiser-requested
          history, support security and audit requirements, resolve billing or support matters, or meet applicable legal
          obligations. Some append-only audit, billing-receipt, and competition-history records may be retained longer
          than editable profile or draft information because they protect the integrity of event and security history.
        </p>
      </section>

      <section>
        <h2>Cookies and local storage</h2>
        <p>
          Matchday uses cookies or browser storage for functions such as authenticated sessions, security controls,
          preferences, and continuity of permitted workflows. Optional analytics or similar non-essential storage should
          follow the consent choices exposed by the service where those features are enabled.
        </p>
      </section>

      <section>
        <h2>Security and access</h2>
        <p>
          The service uses role-based access, protected sessions, scoped scoring credentials, audit records, and other
          safeguards to reduce unauthorised access. No online service can guarantee absolute security; users should keep
          credentials private and report suspected account or access-pass compromise promptly.
        </p>
      </section>

      <section>
        <h2>Your information and policy changes</h2>
        <p>
          Depending on the account and applicable requirements, users may be able to review or update account data and
          organisers may manage competition records through the product. Requests that cannot be completed through the
          product should be directed through the operator&apos;s support channel. Material changes to this policy will be
          reflected on this page with an updated date.
        </p>
      </section>
    </LegalPage>
  );
}
