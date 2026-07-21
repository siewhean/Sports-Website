import type { EmailTemplateReference, RenderedEmail } from "./types.js";

export type EmailTemplate = EmailTemplateReference & {
  subject: string;
  text: string;
  html: string;
  requiredVariables: readonly string[];
};

export class EmailTemplateNotFoundError extends Error {
  constructor(reference: EmailTemplateReference) {
    super(`Email template ${reference.id}@v${reference.version} is not registered`);
    this.name = "EmailTemplateNotFoundError";
  }
}

export class EmailTemplateVariableError extends Error {
  constructor(template: EmailTemplateReference, variable: string) {
    super(`Email template ${template.id}@v${template.version} requires variable ${variable}`);
    this.name = "EmailTemplateVariableError";
  }
}

function keyOf(reference: EmailTemplateReference): string {
  return `${reference.id}@v${reference.version}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function interpolate(source: string, variables: Readonly<Record<string, string>>, escapeValues: boolean): string {
  return source.replaceAll(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, variable: string) => {
    const value = variables[variable] ?? "";
    return escapeValues ? escapeHtml(value) : value;
  });
}

function sanitizeHeaderValue(value: string): string {
  return value.replaceAll(/[\r\n]+/g, " ").trim();
}

function validateActionUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Email template actionUrl must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Email template actionUrl must be an absolute HTTP(S) URL");
  }
}

export class EmailTemplateRegistry {
  readonly #templates = new Map<string, EmailTemplate>();

  constructor(templates: readonly EmailTemplate[] = DEFAULT_EMAIL_TEMPLATES) {
    for (const template of templates) {
      const key = keyOf(template);
      if (this.#templates.has(key)) throw new Error(`Duplicate email template ${key}`);
      this.#templates.set(key, { ...template });
    }
  }

  render(reference: EmailTemplateReference, variables: Readonly<Record<string, string>>): RenderedEmail {
    const template = this.#templates.get(keyOf(reference));
    if (template === undefined) throw new EmailTemplateNotFoundError(reference);

    for (const variable of template.requiredVariables) {
      if (variables[variable]?.trim() === "") {
        throw new EmailTemplateVariableError(reference, variable);
      }
      if (variables[variable] === undefined) {
        throw new EmailTemplateVariableError(reference, variable);
      }
    }
    if (template.requiredVariables.includes("actionUrl")) {
      validateActionUrl(variables.actionUrl ?? "");
    }

    return {
      template: { id: template.id, version: template.version },
      subject: sanitizeHeaderValue(interpolate(template.subject, variables, false)),
      text: interpolate(template.text, variables, false),
      html: interpolate(template.html, variables, true),
    };
  }
}

function template(id: string, subject: string, message: string, requiredVariables: readonly string[]): EmailTemplate {
  return {
    id,
    version: 1,
    subject,
    text: `${message}\n\nOpen Matchday: {{actionUrl}}`,
    html: `<h1>Matchday</h1><p>${message}</p><p><a href="{{actionUrl}}">Open Matchday</a></p>`,
    requiredVariables: [...requiredVariables, "actionUrl"],
  };
}

export const DEFAULT_EMAIL_TEMPLATES: readonly EmailTemplate[] = [
  template("account-confirmation", "Confirm your Matchday account", "Hello {{displayName}}, confirm your account.", [
    "displayName",
  ]),
  template("password-reset", "Reset your Matchday password", "A password reset was requested for your account.", []),
  template(
    "competition-published",
    "{{competitionName}} is published",
    "{{competitionName}} is now visible to participants and spectators.",
    ["competitionName"],
  ),
  template(
    "event-pass-receipt",
    "Your Event Pass receipt",
    "Payment {{receiptNumber}} for {{competitionName}} was received.",
    ["receiptNumber", "competitionName"],
  ),
  template(
    "ai-top-up-receipt",
    "Your AI action top-up receipt",
    "Payment {{receiptNumber}} for {{actionCount}} AI actions was received.",
    ["receiptNumber", "actionCount"],
  ),
  template(
    "schedule-draft-expiry",
    "Schedule draft expires in {{daysRemaining}} day(s)",
    "The schedule draft for {{competitionName}} expires in {{daysRemaining}} day(s).",
    ["competitionName", "daysRemaining"],
  ),
  template(
    "critical-downstream-conflict",
    "Action required: downstream result conflict",
    "A corrected result in {{competitionName}} conflicts with a downstream match.",
    ["competitionName"],
  ),
  template(
    "account-deletion-confirmation",
    "Your Matchday account was deleted",
    "Your Matchday account deletion is complete.",
    [],
  ),
];
