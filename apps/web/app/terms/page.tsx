import { LegalPage } from "@/components/foundation/LegalPage";
import { messages } from "@matchday/ui";

const updatedOn = "26 August 2026";

export default function TermsPage() {
  return (
    <LegalPage title={messages.legal.termsTitle}>
      <p>Last updated: {updatedOn}</p>

      <section>
        <h2>Using Matchday</h2>
        <p>
          Matchday provides competition-management tools for organisers, officials, participants, and spectators. You
          may use the service only for lawful competition operations and only through accounts, access passes, or public
          pages that you are authorised to use.
        </p>
      </section>

      <section>
        <h2>Accounts and organiser responsibility</h2>
        <p>
          Account holders are responsible for keeping their sign-in and scoring-access credentials secure. Organisation
          owners and organisers are responsible for the competition data they enter, the people they invite, the roles
          they grant, and the rules, schedules, results, branding, and public information they choose to publish.
        </p>
      </section>

      <section>
        <h2>Competition records and published information</h2>
        <p>
          Matchday keeps draft and published competition state separate. Information becomes publicly visible when an
          authorised organiser publishes it through the service. Organisers should verify entries, schedules, scores,
          standings, and corrections before publication and should use the available correction and audit workflows when
          a published result changes.
        </p>
      </section>

      <section>
        <h2>Billing and paid features</h2>
        <p>
          Paid plans and optional usage credits are processed through the configured payment provider. Access to paid
          features depends on the organisation&apos;s current subscription or entitlement state. A failed, expired, or
          cancelled subscription may remove access to paid features without deleting competition records that were
          created while the entitlement was active.
        </p>
      </section>

      <section>
        <h2>Acceptable use</h2>
        <p>
          Do not misuse the service, interfere with its operation, attempt to bypass access controls or usage limits,
          upload content you are not entitled to use, impersonate another person, or use competition, messaging, export,
          or AI-assisted features for unlawful, abusive, deceptive, or harmful activity.
        </p>
      </section>

      <section>
        <h2>Service changes and availability</h2>
        <p>
          Competition software depends on networks, browsers, infrastructure, and third-party providers. Matchday may
          change features, limits, integrations, or operational safeguards as the service evolves. Organisers should keep
          appropriate exports or operational backups for events where continued access to records is business-critical.
        </p>
      </section>

      <section>
        <h2>Policy changes</h2>
        <p>
          Material changes to these terms will be reflected on this page with an updated date. Continued use after an
          updated version takes effect means the service is being used under the updated terms, subject to any rights
          that cannot be changed by these terms.
        </p>
      </section>
    </LegalPage>
  );
}
