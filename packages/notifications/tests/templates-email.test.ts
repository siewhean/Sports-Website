import { describe, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";
import {
  createNodemailerSmtpEmailProvider,
  EmailTemplateNotFoundError,
  EmailTemplateRegistry,
  MAILPIT_SMTP_DEFAULTS,
  resolveSmtpTransportTimeouts,
  SmtpEmailProvider,
  type SmtpTransport,
} from "../src/index.js";

describe("EmailTemplateRegistry", () => {
  it("renders an exact version and HTML-escapes untrusted variables", () => {
    const registry = new EmailTemplateRegistry();
    const rendered = registry.render(
      { id: "competition-published", version: 1 },
      {
        competitionName: '<script>alert("x")</script>',
        actionUrl: "https://matchday.test/competition?id=1&tab=public",
      },
    );

    expect(rendered.template).toEqual({ id: "competition-published", version: 1 });
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;");
    expect(rendered.html).toContain("id=1&amp;tab=public");
  });

  it("rejects unknown template versions", () => {
    const registry = new EmailTemplateRegistry();
    expect(() =>
      registry.render(
        { id: "competition-published", version: 2 },
        { competitionName: "League", actionUrl: "https://matchday.test" },
      ),
    ).toThrow(EmailTemplateNotFoundError);
  });

  it("removes newline characters from rendered subjects", () => {
    const registry = new EmailTemplateRegistry();
    const rendered = registry.render(
      { id: "competition-published", version: 1 },
      { competitionName: "League\r\nBcc: attacker@example.test", actionUrl: "https://matchday.test" },
    );
    expect(rendered.subject).toBe("League Bcc: attacker@example.test is published");
  });

  it("rejects non-HTTP action links", () => {
    const registry = new EmailTemplateRegistry();
    expect(() =>
      registry.render({ id: "password-reset", version: 1 }, { actionUrl: "javascript:alert(document.cookie)" }),
    ).toThrow("absolute HTTP(S) URL");
  });
});

describe("SmtpEmailProvider", () => {
  it("wires finite timeout defaults into the real Nodemailer transport", () => {
    const createTransport = vi.spyOn(nodemailer, "createTransport");
    try {
      createNodemailerSmtpEmailProvider(MAILPIT_SMTP_DEFAULTS);
      expect(createTransport).toHaveBeenCalledExactlyOnceWith({
        host: "127.0.0.1",
        port: 1025,
        secure: false,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
        dnsTimeout: 10_000,
      });
    } finally {
      createTransport.mockRestore();
    }
  });

  it("uses finite SMTP transport bounds and rejects unsafe timeout overrides", () => {
    expect(resolveSmtpTransportTimeouts(MAILPIT_SMTP_DEFAULTS)).toEqual({
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      dnsTimeout: 10_000,
    });
    expect(() => resolveSmtpTransportTimeouts({ ...MAILPIT_SMTP_DEFAULTS, socketTimeoutMs: 0 })).toThrow(
      "SMTP socket timeout",
    );
  });

  it("maps a rendered message to an injected Mailpit-compatible SMTP transport", async () => {
    const sendMail = vi.fn<SmtpTransport["sendMail"]>().mockResolvedValue({
      messageId: "mailpit-message-1",
      accepted: ["organiser@example.test"],
    });
    const provider = new SmtpEmailProvider({ sendMail }, MAILPIT_SMTP_DEFAULTS);
    const secretProvider = new SmtpEmailProvider(
      { sendMail },
      { ...MAILPIT_SMTP_DEFAULTS, auth: { username: "mailer", password: "p".repeat(32) } },
    );
    expect(JSON.stringify(secretProvider)).not.toContain("p".repeat(32));

    const receipt = await provider.send({
      to: "organiser@example.test",
      subject: "Test",
      text: "Test body",
      html: "<p>Test body</p>",
      template: { id: "test", version: 1 },
      idempotencyKey: "email-1",
      notificationId: "notification-1",
    });

    expect(receipt.providerMessageId).toBe("mailpit-message-1");
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Matchday <no-reply@matchday.test>",
        to: "organiser@example.test",
        headers: expect.objectContaining({ "X-Matchday-Idempotency-Key": "email-1" }),
      }),
    );
  });

  it("rejects multiple recipients without calling the SMTP transport", async () => {
    const sendMail = vi.fn<SmtpTransport["sendMail"]>();
    const provider = new SmtpEmailProvider({ sendMail }, MAILPIT_SMTP_DEFAULTS);

    await expect(
      provider.send({
        to: "first@example.test, second@example.test",
        subject: "Test",
        text: "Test body",
        html: "<p>Test body</p>",
        template: { id: "test", version: 1 },
        idempotencyKey: "email-fanout",
        notificationId: "notification-fanout",
      }),
    ).rejects.toThrow("exactly one mailbox");
    expect(sendMail).not.toHaveBeenCalled();
  });
});
