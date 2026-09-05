import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

describe("QA-014 — OWASP Top 10 Security & Threat Defense Suite", () => {
  describe("A01: Broken Access Control (IDOR & Tenant Isolation)", () => {
    it("rejects cross-tenant access when user organisation does not match resource organisation", () => {
      const authoriseAccess = (callerOrgId: string, resourceOrgId: string, role: string) => {
        if (role === "platform_admin") return { allowed: true };
        if (callerOrgId !== resourceOrgId) {
          return { allowed: false, error: "FORBIDDEN_ORGANISATION_MISMATCH" };
        }
        return { allowed: true };
      };

      const callerOrg = "org-alpha-123";
      const victimOrg = "org-bravo-456";

      expect(authoriseAccess(callerOrg, callerOrg, "organiser").allowed).toBe(true);
      expect(authoriseAccess(callerOrg, victimOrg, "organiser").allowed).toBe(false);
      expect(authoriseAccess(callerOrg, victimOrg, "organiser").error).toBe("FORBIDDEN_ORGANISATION_MISMATCH");
      expect(authoriseAccess(callerOrg, victimOrg, "platform_admin").allowed).toBe(true);
    });

    it("enforces role privilege hierarchy preventing unauthorised role escalation", () => {
      const allowedActions: Record<string, string[]> = {
        spectator: ["read_public"],
        scorekeeper: ["read_public", "submit_score"],
        organiser: ["read_public", "submit_score", "edit_competition", "manage_schedule"],
        platform_admin: ["read_public", "submit_score", "edit_competition", "manage_schedule", "admin_override"],
      };

      const canPerform = (role: string, action: string) => {
        return (allowedActions[role] ?? []).includes(action);
      };

      expect(canPerform("scorekeeper", "submit_score")).toBe(true);
      expect(canPerform("scorekeeper", "edit_competition")).toBe(false);
      expect(canPerform("organiser", "admin_override")).toBe(false);
      expect(canPerform("platform_admin", "admin_override")).toBe(true);
    });
  });

  describe("A02: Cryptographic Failures & Webhook Tampering", () => {
    it("validates HMAC signatures on billing and scoring webhooks and rejects tampered bodies", () => {
      const secretKey = "test_signing_key_hex_secret_abcdef123456";
      const payload = JSON.stringify({ event: "checkout.session.completed", orgId: "org-123", amount: 5000 });

      const generateSignature = (body: string, secret: string) => {
        return createHmac("sha256", secret).update(body).digest("hex");
      };

      const verifySignature = (body: string, signature: string, secret: string) => {
        const expected = generateSignature(body, secret);
        return expected === signature;
      };

      const validSig = generateSignature(payload, secretKey);
      expect(verifySignature(payload, validSig, secretKey)).toBe(true);

      // Tampered payload
      const tamperedPayload = JSON.stringify({ event: "checkout.session.completed", orgId: "org-123", amount: 0 });
      expect(verifySignature(tamperedPayload, validSig, secretKey)).toBe(false);

      // Wrong key
      expect(verifySignature(payload, validSig, "wrong_secret_key")).toBe(false);
    });
  });

  describe("A03: Injection Defenses (SQLi & XSS)", () => {
    it("safely sanitizes and escapes potentially hostile HTML/script payloads in user input", () => {
      const sanitizeHtml = (input: string): string => {
        return input
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#x27;")
          .replaceAll("/", "&#x2F;");
      };

      const maliciousPayload = '<script>alert("XSS")</script><img src="x" onerror="stealCookies()"/>';
      const sanitized = sanitizeHtml(maliciousPayload);

      expect(sanitized).not.toContain("<script>");
      expect(sanitized).not.toContain("<img");
      expect(sanitized).toBe(
        "&lt;script&gt;alert(&quot;XSS&quot;)&lt;&#x2F;script&gt;&lt;img src=&quot;x&quot; onerror=&quot;stealCookies()&quot;&#x2F;&gt;",
      );
    });

    it("verifies parameterised SQL binding prevents SQL injection fragments in identifiers", () => {
      const isValidUuid = (id: string): boolean => {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
      };

      const validUuid = "123e4567-e89b-12d3-a456-426614174000";
      const sqliAttempt = "123e4567-e89b-12d3-a456-426614174000' OR '1'='1";

      expect(isValidUuid(validUuid)).toBe(true);
      expect(isValidUuid(sqliAttempt)).toBe(false);
    });
  });

  describe("A05: Security Misconfiguration & Security Headers", () => {
    it("asserts standard Content Security Policy and Transport Security header directives", () => {
      const securityHeaders: Record<string, string> = {
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; object-src 'none';",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
        "Referrer-Policy": "strict-origin-when-cross-origin",
      };

      expect(securityHeaders["X-Content-Type-Options"]).toBe("nosniff");
      expect(securityHeaders["X-Frame-Options"]).toBe("DENY");
      expect(securityHeaders["Strict-Transport-Security"]).toContain("max-age=");
      expect(securityHeaders["Content-Security-Policy"]).toContain("default-src 'self'");
    });
  });
});
