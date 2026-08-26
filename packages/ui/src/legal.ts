export const legalMessages = {
  updatedOn: "26 August 2026",
  lastUpdated: "Last updated",
  terms: {
    sections: [
      {
        title: "Using Matchday",
        body: "Matchday provides competition-management tools for organisers, officials, participants, and spectators. You may use the service only for lawful competition operations and only through accounts, access passes, or public pages that you are authorised to use.",
      },
      {
        title: "Accounts and organiser responsibility",
        body: "Account holders are responsible for keeping their sign-in and scoring-access credentials secure. Organisation owners and organisers are responsible for the competition data they enter, the people they invite, the roles they grant, and the rules, schedules, results, branding, and public information they choose to publish.",
      },
      {
        title: "Competition records and published information",
        body: "Matchday keeps draft and published competition state separate. Information becomes publicly visible when an authorised organiser publishes it through the service. Organisers should verify entries, schedules, scores, standings, and corrections before publication and should use the available correction and audit workflows when a published result changes.",
      },
      {
        title: "Billing and paid features",
        body: "Paid plans and optional usage credits are processed through the configured payment provider. Access to paid features depends on the organisation's current subscription or entitlement state. A failed, expired, or cancelled subscription may remove access to paid features without deleting competition records that were created while the entitlement was active.",
      },
      {
        title: "Acceptable use",
        body: "Do not misuse the service, interfere with its operation, attempt to bypass access controls or usage limits, upload content you are not entitled to use, impersonate another person, or use competition, messaging, export, or AI-assisted features for unlawful, abusive, deceptive, or harmful activity.",
      },
      {
        title: "Service changes and availability",
        body: "Competition software depends on networks, browsers, infrastructure, and third-party providers. Matchday may change features, limits, integrations, or operational safeguards as the service evolves. Organisers should keep appropriate exports or operational backups for events where continued access to records is business-critical.",
      },
      {
        title: "Policy changes",
        body: "Material changes to these terms will be reflected on this page with an updated date. Continued use after an updated version takes effect means the service is being used under the updated terms, subject to any rights that cannot be changed by these terms.",
      },
    ],
  },
  privacy: {
    sections: [
      {
        title: "Information Matchday processes",
        body: "Matchday processes account and organisation information, competition setup and entry data, schedules, scoring and results, access and audit records, notification preferences, support/admin actions, and technical records needed to operate and secure the service. Billing records may include provider customer, subscription, event, and transaction references; payment-card details are handled by the configured payment provider rather than stored as Matchday competition data.",
      },
      {
        title: "Why the information is used",
        body: "Information is used to authenticate users, enforce permissions and entitlements, run competitions, calculate standings and advancement, publish organiser-approved information, deliver notifications, process billing, investigate support or security events, maintain audit history, and improve the reliability of the service.",
      },
      {
        title: "Public competition information",
        body: "Competition names, schedules, participants, standings, brackets, results, sponsor or branding information, and similar event content may become publicly accessible when an authorised organiser publishes them. Draft data is not intended for the public surface. Organisers should avoid placing unnecessary sensitive personal data in fields that may later be published.",
      },
      {
        title: "Service providers and disclosures",
        body: "Matchday may send the minimum information needed to infrastructure, identity, email, payment, observability, and other configured service providers that support the requested feature. Information may also be disclosed when required to protect the service, users, or others, or to comply with applicable legal obligations.",
      },
      {
        title: "Retention and deletion",
        body: "Competition and account records are retained while needed to provide the service, preserve organiser-requested history, support security and audit requirements, resolve billing or support matters, or meet applicable legal obligations. Some append-only audit, billing-receipt, and competition-history records may be retained longer than editable profile or draft information because they protect the integrity of event and security history.",
      },
      {
        title: "Cookies and local storage",
        body: "Matchday uses cookies or browser storage for functions such as authenticated sessions, security controls, preferences, and continuity of permitted workflows. Optional analytics or similar non-essential storage should follow the consent choices exposed by the service where those features are enabled.",
      },
      {
        title: "Security and access",
        body: "The service uses role-based access, protected sessions, scoped scoring credentials, audit records, and other safeguards to reduce unauthorised access. No online service can guarantee absolute security; users should keep credentials private and report suspected account or access-pass compromise promptly.",
      },
      {
        title: "Your information and policy changes",
        body: "Depending on the account and applicable requirements, users may be able to review or update account data and organisers may manage competition records through the product. Requests that cannot be completed through the product should be directed through the operator's support channel. Material changes to this policy will be reflected on this page with an updated date.",
      },
    ],
  },
} as const;
