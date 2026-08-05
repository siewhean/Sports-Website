import {
  AuthorizationResponseError,
  ClientError,
  ClientSecretBasic,
  ResponseBodyError,
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  clockTolerance,
  customFetch,
  discovery,
  type Configuration,
  type CustomFetch,
} from "openid-client";
import {
  IdentityError,
  type IdentityProviderPort,
  type ProviderAuthorizationRequest,
  type ProviderClaims,
  type ProviderSignInRequest,
} from "@matchday/identity";

export type OidcProviderOptions = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  callbackUri: string;
  allowInsecureLoopback?: boolean;
  fetch?: CustomFetch;
  requestTimeoutMs?: number;
};

function safeEndpoint(value: string | undefined, allowInsecureLoopback: boolean): void {
  if (!value) throw new Error("OIDC discovery metadata is missing a required endpoint.");
  const url = new URL(value);
  const loopback = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(allowInsecureLoopback && loopback))) {
    throw new Error("OIDC discovery metadata contains an unsafe endpoint.");
  }
}

function invalidAuthentication(): IdentityError {
  return new IdentityError("AUTHENTICATION_FAILED", "Authentication could not be completed.");
}

const providerUnavailableClientErrorCodes = new Set([
  "OAUTH_TIMEOUT",
  "OAUTH_ABORT",
  "OAUTH_RESPONSE_IS_NOT_CONFORM",
  "OAUTH_RESPONSE_IS_NOT_JSON",
  "OAUTH_PARSE_ERROR",
]);

function isProviderUnavailableClientError(error: ClientError): boolean {
  return typeof error.code === "string" && providerUnavailableClientErrorCodes.has(error.code);
}

export class OidcIdentityProvider implements IdentityProviderPort {
  readonly #callbackUri: string;
  readonly #configuration: Configuration;
  readonly #issuer: string;

  constructor(configuration: Configuration, identity: Pick<OidcProviderOptions, "callbackUri" | "issuer">) {
    this.#configuration = configuration;
    this.#callbackUri = identity.callbackUri;
    this.#issuer = identity.issuer;
  }

  async createAuthorizationUrl(request: ProviderAuthorizationRequest): Promise<string> {
    if (request.redirectUri !== this.#callbackUri) throw invalidAuthentication();
    return buildAuthorizationUrl(this.#configuration, {
      redirect_uri: request.redirectUri,
      scope: "openid email profile",
      state: request.state,
      nonce: request.nonce,
      code_challenge: request.pkceChallenge,
      code_challenge_method: "S256",
      ...(request.prompt ? { prompt: request.prompt } : {}),
    }).href;
  }

  async exchangeAuthorizationCode(request: ProviderSignInRequest): Promise<ProviderClaims> {
    if (
      request.redirectUri !== this.#callbackUri ||
      !request.authorizationResponseState ||
      !request.expectedState ||
      !request.expectedNonce
    ) {
      throw invalidAuthentication();
    }
    const callback = new URL(this.#callbackUri);
    callback.searchParams.set("code", request.authorizationCode);
    callback.searchParams.set("state", request.authorizationResponseState);
    try {
      const tokens = await authorizationCodeGrant(this.#configuration, callback, {
        expectedState: request.expectedState,
        expectedNonce: request.expectedNonce,
        pkceCodeVerifier: request.pkceVerifier,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw invalidAuthentication();
      const issuer = claims.iss;
      const subject = claims.sub;
      const email = claims.email;
      const emailVerified = claims.email_verified;
      const preferredName = claims.name ?? claims.preferred_username;
      const providerSessionId = claims.sid;
      if (
        typeof issuer !== "string" ||
        issuer !== this.#issuer ||
        issuer.length > 2_048 ||
        typeof subject !== "string" ||
        subject.length < 1 ||
        subject.length > 512 ||
        typeof email !== "string" ||
        email.length > 254 ||
        typeof emailVerified !== "boolean"
      ) {
        throw invalidAuthentication();
      }
      if (
        providerSessionId !== undefined &&
        (typeof providerSessionId !== "string" || providerSessionId.length < 1 || providerSessionId.length > 512)
      ) {
        throw invalidAuthentication();
      }
      const displayName =
        typeof preferredName === "string" && preferredName.trim()
          ? preferredName
          : email.slice(0, Math.max(1, email.indexOf("@")));
      return { issuer, subject, providerSessionId: providerSessionId ?? null, email, emailVerified, displayName };
    } catch (error) {
      if (error instanceof IdentityError) throw error;
      if (error instanceof ResponseBodyError) {
        if (error.error === "invalid_grant" || error.error === "invalid_request") throw invalidAuthentication();
        throw error;
      }
      if (error instanceof ClientError && isProviderUnavailableClientError(error)) throw error;
      if (error instanceof AuthorizationResponseError || error instanceof ClientError) {
        throw invalidAuthentication();
      }
      throw error;
    }
  }

  async requestRecovery(): Promise<void> {
    // Password recovery is deliberately provider-hosted; OIDC has no standard reset API.
    throw new Error("Recovery is provider-hosted.");
  }
}

export async function createOidcIdentityProvider(options: OidcProviderOptions): Promise<OidcIdentityProvider> {
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 10 || requestTimeoutMs > 30_000) {
    throw new Error("OIDC request timeout must be an integer between 10 and 30000 milliseconds.");
  }
  const metadata = {
    client_secret: options.clientSecret,
    redirect_uris: [options.callbackUri],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_basic",
    [clockTolerance]: 60,
  };
  const execute = options.allowInsecureLoopback ? [allowInsecureRequests] : [];
  const providerFetch = (options.fetch ?? globalThis.fetch) as unknown as CustomFetch;
  const boundedFetch: CustomFetch = (input, init) => {
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return providerFetch(input, { ...init, signal });
  };
  const configuration = await discovery(
    new URL(options.issuer),
    options.clientId,
    metadata,
    ClientSecretBasic(options.clientSecret),
    {
      [customFetch]: boundedFetch,
      ...(execute.length ? { execute } : {}),
    },
  );
  configuration.timeout = Math.ceil(requestTimeoutMs / 1_000);
  const server = configuration.serverMetadata();
  if (server.issuer !== options.issuer) throw new Error("OIDC discovery issuer does not match configured issuer.");
  safeEndpoint(server.authorization_endpoint, Boolean(options.allowInsecureLoopback));
  safeEndpoint(server.token_endpoint, Boolean(options.allowInsecureLoopback));
  safeEndpoint(server.jwks_uri, Boolean(options.allowInsecureLoopback));
  if (!server.response_types_supported?.includes("code")) {
    throw new Error("OIDC provider does not support the authorization code flow.");
  }
  if (server.code_challenge_methods_supported && !server.code_challenge_methods_supported.includes("S256")) {
    throw new Error("OIDC provider does not support PKCE S256.");
  }
  return new OidcIdentityProvider(configuration, { callbackUri: options.callbackUri, issuer: options.issuer });
}
