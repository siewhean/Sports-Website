import nodemailer, { type Transporter } from "nodemailer";
import addressparser from "nodemailer/lib/addressparser/index.js";
import type { EmailMessage } from "./types.js";

export type EmailDeliveryReceipt = {
  providerMessageId: string;
  accepted: readonly string[];
};

export interface EmailProvider {
  send(message: EmailMessage): Promise<EmailDeliveryReceipt>;
}

export function requireSingleEmailMailbox(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("Email recipient must be exactly one mailbox");
  const parsed = addressparser(value, { flatten: true });
  const mailbox = parsed[0]?.address.trim();
  if (parsed.length !== 1 || mailbox === undefined || mailbox === "") {
    throw new Error("Email recipient must be exactly one mailbox");
  }
  return mailbox;
}

export type SmtpTransportMessage = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  headers: Readonly<Record<string, string>>;
};

export type SmtpTransportReceipt = {
  messageId: string;
  accepted?: readonly string[];
};

export interface SmtpTransport {
  sendMail(message: SmtpTransportMessage): Promise<SmtpTransportReceipt>;
}

export type SmtpEmailProviderConfig = {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  auth?: { username: string; password: string };
};

export const MAILPIT_SMTP_DEFAULTS: SmtpEmailProviderConfig = {
  host: "127.0.0.1",
  port: 1025,
  secure: false,
  from: "Matchday <no-reply@matchday.test>",
};

export class SmtpEmailProvider implements EmailProvider {
  readonly #from: string;
  readonly #transport: SmtpTransport;

  constructor(transport: SmtpTransport, config: SmtpEmailProviderConfig) {
    if (config.host.trim() === "") throw new Error("SMTP host is required");
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
      throw new Error("SMTP port must be between 1 and 65535");
    }
    if (config.from.trim() === "") throw new Error("SMTP from address is required");
    this.#transport = transport;
    this.#from = config.from;
  }

  async send(message: EmailMessage): Promise<EmailDeliveryReceipt> {
    const recipient = requireSingleEmailMailbox(message.to);
    const receipt = await this.#transport.sendMail({
      from: this.#from,
      to: recipient,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: {
        "X-Matchday-Idempotency-Key": message.idempotencyKey,
        "X-Matchday-Notification-Id": message.notificationId,
        "X-Matchday-Template": `${message.template.id}@v${message.template.version}`,
      },
    });

    return {
      providerMessageId: receipt.messageId,
      accepted: receipt.accepted ?? [recipient],
    };
  }
}

export class NodemailerSmtpTransport implements SmtpTransport {
  readonly #transporter: Transporter;

  constructor(transporter: Transporter) {
    this.#transporter = transporter;
  }

  async sendMail(message: SmtpTransportMessage): Promise<SmtpTransportReceipt> {
    const receipt = await this.#transporter.sendMail(message);
    const accepted = Array.isArray(receipt.accepted)
      ? receipt.accepted.map((recipient: unknown) =>
          typeof recipient === "string" ? recipient : JSON.stringify(recipient),
        )
      : [];
    return { messageId: String(receipt.messageId), accepted };
  }
}

export function createNodemailerSmtpEmailProvider(config: SmtpEmailProviderConfig): SmtpEmailProvider {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.auth === undefined ? {} : { auth: { user: config.auth.username, pass: config.auth.password } }),
  });
  return new SmtpEmailProvider(new NodemailerSmtpTransport(transporter), config);
}

export type DeliveryFailureClassification = "transient" | "permanent";

export type SmtpLikeError = Error & {
  code?: string;
  responseCode?: number;
};

export class EmailRecipientRejectedError extends Error {
  readonly code = "EINVALIDRECIPIENT";

  constructor() {
    super("Email provider did not accept any recipient");
    this.name = "EmailRecipientRejectedError";
  }
}

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "ESOCKET",
]);

const PERMANENT_INPUT_CODES = new Set(["EENVELOPE", "EINVALIDRECIPIENT"]);

export function classifyEmailDeliveryError(error: unknown): DeliveryFailureClassification {
  if (!(error instanceof Error)) return "transient";

  const smtpError = error as SmtpLikeError;
  if (smtpError.responseCode !== undefined) {
    if (smtpError.responseCode >= 500) return "permanent";
    if (smtpError.responseCode >= 400) return "transient";
  }
  if (smtpError.code !== undefined && PERMANENT_INPUT_CODES.has(smtpError.code)) return "permanent";
  if (smtpError.code !== undefined && TRANSIENT_NETWORK_CODES.has(smtpError.code)) return "transient";
  return "transient";
}
