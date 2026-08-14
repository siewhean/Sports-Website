import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOidcIdentityProvider } from "../../src/oidc-provider.js";

const MFA_ACR = "http://schemas.openid.net/pape/policies/2007/06/multi-factor";

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signIdToken(privateKey: KeyObject, claims: object): string {
  const body = `${encode({ alg: "RS256", kid: "test-key", typ: "JWT" })}.${encode(claims)}`;
  const signature = createSign("RSA-SHA256").update(body).end().sign(privateKey).toString("base64url");
  return `${body}.${signature}`;
}

describe("OidcIdentityProvider", () => {
  let server: Server;
  let issuer: string;
  let privateKey: KeyObject;
  let publicJwk: Record<string, unknown>;
  let expectedNonce = "nonce-not-set";
  let claimOverrides: Record<string, unknown> = {};
  let tokenResponseDelayMs = 0;
  const observedTokenBodies: URLSearchParams[] = [];

  beforeAll(async () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    privateKey = keys.privateKey;
    publicJwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "test-key", use: "sig", alg: "RS256" };
    server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", issuer || "http://127.0.0.1");
      if (url.pathname === "/.well-known/openid-configuration") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
            token_endpoint_auth_methods_supported: ["client_secret_basic"],
            code_challenge_methods_supported: ["S256"],
          }),
        );
        return;
      }
      if (url.pathname === "/jwks") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ keys: [publicJwk] }));
        return;
      }
      if (url.pathname === "/token" && request.method === "POST") {
        let body = "";
        for await (const chunk of request) body += chunk.toString();
        const parameters = new URLSearchParams(body);
        observedTokenBodies.push(parameters);
        if (tokenResponseDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, tokenResponseDelayMs));
        }
        const now = Math.floor(Date.now() / 1_000);
        const idToken = signIdToken(privateKey, {
          iss: issuer,
          aud: "test-client",
          sub: "provider-subject",
          sid: "provider-session-123",
          email: "organiser@example.test",
          email_verified: true,
          name: "Test Organiser",
          nonce: expectedNonce,
          iat: now,
          exp: now + 300,
          ...claimOverrides,
        });
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({ access_token: "access-token", token_type: "Bearer", expires_in: 300, id_token: idToken }),
        );
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("OIDC test server did not bind");
    issuer = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  async function provider(
    requestTimeoutMs?: number,
    assurance?: { authorizationAcrValues?: readonly string[]; maxAuthenticationAgeSeconds?: number },
  ) {
    return createOidcIdentityProvider({
      issuer,
      clientId: "test-client",
      clientSecret: "test-client-secret",
      callbackUri: "http://127.0.0.1:4000/api/v1/identity/callback",
      allowInsecureLoopback: true,
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
      ...(assurance?.authorizationAcrValues
        ? { authorizationAcrValues: assurance.authorizationAcrValues }
        : {}),
      ...(assurance?.maxAuthenticationAgeSeconds !== undefined
        ? { maxAuthenticationAgeSeconds: assurance.maxAuthenticationAgeSeconds }
        : {}),
    });
  }

  it("builds code+PKCE authorization, requests MFA context, and validates signed assurance claims", async () => {
    const adapter = await provider(undefined, {
      authorizationAcrValues: [MFA_ACR],
      maxAuthenticationAgeSeconds: 900,
    });
    expect(JSON.stringify(adapter)).not.toContain("test-client-secret");
    expectedNonce = "n".repeat(43);
    const authTime = Math.floor(Date.now() / 1_000);
    claimOverrides = { amr: ["mfa"], acr: MFA_ACR, auth_time: authTime };
    const authorization = new URL(
      await adapter.createAuthorizationUrl({
        redirectUri: "http://127.0.0.1:4000/api/v1/identity/callback",
        state: "s".repeat(43),
        nonce: expectedNonce,
        pkceChallenge: "c".repeat(43),
      }),
    );
    expect(authorization.origin).toBe(issuer);
    expect(authorization.searchParams.get("response_type")).toBe("code");
    expect(authorization.searchParams.get("scope")).toBe("openid email profile");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("acr_values")).toBe(MFA_ACR);
    expect(authorization.searchParams.get("max_age")).toBe("900");
    expect(authorization.searchParams.has("client_secret")).toBe(false);

    await expect(
      adapter.exchangeAuthorizationCode({
        authorizationCode: "one-time-code",
        redirectUri: "http://127.0.0.1:4000/api/v1/identity/callback",
        pkceVerifier: "v".repeat(43),
        authorizationResponseState: "s".repeat(43),
        expectedState: "s".repeat(43),
        expectedNonce,
      }),
    ).resolves.toEqual({
      issuer,
      subject: "provider-subject",
      providerSessionId: "provider-session-123",
      email: "organiser@example.test",
      emailVerified: true,
      displayName: "Test Organiser",
      assurance: {
        methods: ["mfa"],
        acr: MFA_ACR,
        authenticatedAt: new Date(authTime * 1_000),
        phishingResistant: false,
      },
    });
    expect(observedTokenBodies.at(-1)?.get("code_verifier")).toBe("v".repeat(43));
    expect(observedTokenBodies.at(-1)?.get("redirect_uri")).toBe("http://127.0.0.1:4000/api/v1/identity/callback");
  });

  it("rejects invalid authorization assurance context before provider discovery", async () => {
    await expect(
      createOidcIdentityProvider({
        issuer: "https://identity.example.test",
        clientId: "test-client",
        clientSecret: "test-client-secret",
        callbackUri: "https://api.matchday.test/api/v1/identity/callback",
        authorizationAcrValues: [MFA_ACR, MFA_ACR],
      }),
    ).rejects.toThrow("OIDC acr_values must not contain duplicates");
  });

  it("rejects state, nonce, issuer, and required-claim mismatches", async () => {
    const adapter = await provider();
    const exchange = (overrides: Record<string, string> = {}) =>
      adapter.exchangeAuthorizationCode({
        authorizationCode: "one-time-code",
        redirectUri: "http://127.0.0.1:4000/api/v1/identity/callback",
        pkceVerifier: "v".repeat(43),
        authorizationResponseState: "s".repeat(43),
        expectedState: "s".repeat(43),
        expectedNonce: "n".repeat(43),
        ...overrides,
      });

    expectedNonce = "n".repeat(43);
    claimOverrides = {};
    await expect(exchange({ authorizationResponseState: "x".repeat(43) })).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
    expectedNonce = "wrong-nonce";
    await expect(exchange()).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expectedNonce = "n".repeat(43);
    claimOverrides = { iss: "https://attacker.example" };
    await expect(exchange()).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    claimOverrides = { email_verified: "yes" };
    await expect(exchange()).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    claimOverrides = {};
  });

  it("bounds discovery when the provider does not respond", async () => {
    const hangingFetch: NonNullable<Parameters<typeof createOidcIdentityProvider>[0]["fetch"]> = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    await expect(
      createOidcIdentityProvider({
        issuer: "https://identity-timeout.example",
        clientId: "test-client",
        clientSecret: "test-client-secret",
        callbackUri: "https://api.matchday.test/api/v1/identity/callback",
        requestTimeoutMs: 20,
        fetch: hangingFetch,
      }),
    ).rejects.toBeDefined();
  });

  it("preserves token endpoint timeouts as provider availability failures", async () => {
    const adapter = await provider(20);
    expectedNonce = "n".repeat(43);
    claimOverrides = {};
    tokenResponseDelayMs = 100;
    await expect(
      adapter.exchangeAuthorizationCode({
        authorizationCode: "one-time-code",
        redirectUri: "http://127.0.0.1:4000/api/v1/identity/callback",
        pkceVerifier: "v".repeat(43),
        authorizationResponseState: "s".repeat(43),
        expectedState: "s".repeat(43),
        expectedNonce,
      }),
    ).rejects.toMatchObject({ name: "ClientError", code: "OAUTH_TIMEOUT" });
    tokenResponseDelayMs = 0;
  });
});
