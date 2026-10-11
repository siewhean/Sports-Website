/**
 * Launch placeholders. These are rendered visibly (highlighted) on /privacy and /terms so they cannot
 * be missed. Replace every value before public launch and tick the matching item in
 * docs/operations/LAUNCH_CHECKLIST.md.
 */
export const legalPlaceholders = {
  organisationName: "[ORGANISATION LEGAL NAME]",
  registrationNumber: "[UEN / REGISTRATION NUMBER]",
  registeredAddress: "[REGISTERED ADDRESS]",
  dpoEmail: "[DPO EMAIL]",
  governingLawCourts: "[COURTS / DISPUTE RESOLUTION FORUM]",
} as const;

const p = legalPlaceholders;

/** Section after which the retention schedule table is rendered. */
export const retentionSectionTitle = "How long we keep it";

/**
 * The retention schedule shown in the privacy policy. Periods must match the defaults in
 * packages/config/src/retention.ts (PDPA_RETENTION_* environment variables).
 */
export const retentionSchedule = [
  {
    data: "Sign-in sessions (including expired or signed-out sessions)",
    period: "Deleted 30 days after they expire or are revoked",
  },
  {
    data: "Scoring access attempt and rate-limit records",
    period: "Deleted 30 days after the attempt",
  },
  {
    data: "In-app notifications and the emails queued for them",
    period: "Deleted 180 days after they are created",
  },
  {
    data: "Billing webhook receipts from our payment provider",
    period: "Deleted 400 days after receipt. Subscription and entitlement state is kept while the organisation exists",
  },
  {
    data: "Identity-provider event records (used to prevent replays)",
    period: "Deleted 90 days after receipt",
  },
  {
    data: "Casual games started without an account",
    period: "Deleted 30 days after they are created",
  },
  {
    data: "Your account profile",
    period: "Kept until you delete your account, then replaced with anonymous values straight away",
  },
  {
    data: "Audit history and published competition records",
    period:
      "Kept to protect the integrity of results and security history. After you delete your account they show Deleted user rather than your details",
  },
] as const;

export const legalMessages = {
  updatedOn: "9 October 2026",
  lastUpdated: "Last updated",
  terms: {
    sections: [
      {
        title: "Who provides Matchday",
        body: `Matchday is provided by ${p.organisationName} (${p.registrationNumber}), whose registered address is ${p.registeredAddress} ("we", "us"). You can contact us at ${p.dpoEmail}.`,
      },
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
        title: "Governing law and disputes",
        body: `These terms are governed by the laws of Singapore. Any dispute about them or about the service is to be resolved in ${p.governingLawCourts}, subject to any rights you have under Singapore law that cannot be excluded by agreement.`,
      },
      {
        title: "Policy changes",
        body: "Material changes to these terms will be reflected on this page with an updated date. Continued use after an updated version takes effect means the service is being used under the updated terms, subject to any rights that cannot be changed by these terms.",
      },
    ],
  },
  privacy: {
    retentionHeading: "Retention schedule",
    retentionDataColumn: "Data",
    retentionPeriodColumn: "How long we keep it",
    accountLink: "Go to your account page",
    cookiesLink: "Read the cookie policy",
    intro:
      "This policy explains, in plain language, what personal data Matchday collects, why, who sees it, how long we keep it and how you can exercise your rights under Singapore's Personal Data Protection Act 2012 (PDPA).",
    sections: [
      {
        title: "Who we are",
        body: `Matchday is operated by ${p.organisationName} (${p.registrationNumber}), ${p.registeredAddress}. We are the organisation responsible for the personal data described here.`,
      },
      {
        title: "Data protection officer",
        body: `Our data protection officer handles access, correction, deletion and withdrawal-of-consent requests and any privacy complaint. Contact: ${p.dpoEmail}.`,
      },
      {
        title: "What we collect",
        body: "Your account details (name and email address from your sign-in provider), organisation memberships and roles, notification preferences and notifications, casual games, friends and presets you create, sign-in session records (times, expiry and the sign-in method used), billing records for organisations you own, and the actions you take in the service, which are recorded in an audit history. Organisers also enter competition data such as team, participant and official names. We do not store payment card numbers; our payment provider does.",
      },
      {
        title: "Why we use it",
        body: "To sign you in and keep your account secure, enforce permissions and plans, run competitions and calculate standings, publish what organisers approve, send the notifications and emails you ask for, process billing, investigate support and security issues, keep an audit history, and keep the service reliable. We rely on your consent or on the service you asked us to provide. You can withdraw consent at any time (see Your rights).",
      },
      {
        title: "What is public",
        body: "Competition names, schedules, team and participant names, standings, brackets, results, sponsor and branding information become public when an authorised organiser publishes them. Draft data is not public. Organisers should avoid entering unnecessary personal data in fields that may be published. Your account email address is never published.",
      },
      {
        title: "Who we share it with, and overseas transfers",
        body: "We use service providers who handle personal data on our behalf, some of them outside Singapore. Our identity provider Auth0 (United States) handles sign-in and holds your login credentials. Our hosting and web delivery provider Vercel (United States and global edge network) serves the website. Our application servers and database run on Oracle Cloud Infrastructure in the United States (Phoenix, Arizona), and the website's server functions run in Vercel's United States (San Francisco) region. Sentry (United States) receives error diagnostics. Our email provider delivers notification emails and sees your email address and the message. Our payment provider, Stripe, processes payments for organisations. We choose providers that give contractual protection comparable to the PDPA's standard, and share only what each needs. We may also disclose data when the law requires it or to protect users and the service.",
      },
      {
        title: retentionSectionTitle,
        body: "We delete data when we no longer need it. The schedule below is applied automatically every few hours. Audit history is append-only and cannot be edited, so when you delete your account it is kept but no longer identifies you.",
      },
      {
        title: "Your rights",
        body: "You can ask to access the personal data we hold about you, to correct it, to delete it, and to withdraw consent. Access: sign in and use Download my data on your account page for a JSON copy. Deletion: use Delete my account on the same page; your details are replaced with anonymous values immediately and you are signed out everywhere. Correction: update your name where the product allows it, or email the data protection officer for anything else. Withdrawal of consent: switch notifications off in your notification settings, or email the data protection officer; we will tell you what the withdrawal means for the service. If you cannot use the account page, email the data protection officer and we will respond within 30 days. If you are the only owner of an organisation with published or live competitions we cannot delete your account until those competitions are finished or archived, because there is no ownership transfer yet; the data protection officer can help. Deleting your account also leaves your login record with Auth0 until removed on request, so ask the data protection officer if you want that removed too.",
      },
      {
        title: "Cookies and local storage",
        body: "We use essential cookies to keep you signed in and secure, and optional storage only with your consent. See the cookie policy for the full list and how to change your choice.",
      },
      {
        title: "Security",
        body: "We use role-based access, protected sessions, scoped scoring credentials, encryption in transit, audit records and other safeguards. No online service is perfectly secure. Keep your credentials private and tell us promptly if you suspect misuse. If a data breach is likely to cause you significant harm we will notify you and the Personal Data Protection Commission as the PDPA requires.",
      },
      {
        title: "Changes to this policy",
        body: "Material changes will be shown on this page with a new date.",
      },
    ],
  },
} as const;
