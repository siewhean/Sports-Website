export function requestOriginMatchesHost(
  requestOrigin: string | null,
  requestHost: string | null,
  requestProtocol: string | null,
): boolean {
  if (!requestOrigin || !requestHost || !requestProtocol || /[\u0000-\u001f\u007f]/.test(requestHost)) return false;
  try {
    const origin = new URL(requestOrigin);
    const protocol = requestProtocol.replace(/:$/, "").toLowerCase();
    return (
      (protocol === "http" || protocol === "https") &&
      origin.protocol === `${protocol}:` &&
      origin.host.toLowerCase() === requestHost.toLowerCase() &&
      origin.username === "" &&
      origin.password === "" &&
      origin.pathname === "/" &&
      origin.search === "" &&
      origin.hash === ""
    );
  } catch {
    return false;
  }
}

const REQUEST_HEADERS = {
  forwardedHost: "x-forwarded-host",
  host: "host",
  forwardedProtocol: "x-forwarded-proto",
} as const;
const HTTPS_PROTOCOL = "https";
const HTTP_PROTOCOL = "http";

export function requestForwardedOrigin(requestHeaders: Headers): string | null {
  const host = (requestHeaders.get(REQUEST_HEADERS.forwardedHost) ?? requestHeaders.get(REQUEST_HEADERS.host))
    ?.split(",")[0]
    ?.trim();
  const protocol =
    requestHeaders.get(REQUEST_HEADERS.forwardedProtocol)?.split(",")[0]?.trim() === HTTPS_PROTOCOL
      ? HTTPS_PROTOCOL
      : HTTP_PROTOCOL;
  if (!host || /[\s/\\]/u.test(host)) return null;
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return null;
  }
}

export function configuredPublicOrigin(value: string | undefined): string | null {
  const configured = value?.trim();
  if (!configured) return null;
  try {
    const origin = new URL(configured);
    if (
      (origin.protocol !== `${HTTP_PROTOCOL}:` && origin.protocol !== `${HTTPS_PROTOCOL}:`) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    ) {
      return null;
    }
    return origin.origin;
  } catch {
    return null;
  }
}

export function requestPublicOrigin(requestHeaders: Headers, configuredOrigin: string | undefined): string | null {
  return configuredPublicOrigin(configuredOrigin) ?? requestForwardedOrigin(requestHeaders);
}

export function requestOriginAllowed(
  requestOrigin: string | null,
  requestHeaders: Headers,
  configuredOrigin: string | undefined,
  fallbackProtocol: string | null,
): boolean {
  const publicOrigin = configuredPublicOrigin(configuredOrigin);
  if (publicOrigin !== null) return requestOrigin === publicOrigin;
  const requestHost =
    requestHeaders.get(REQUEST_HEADERS.forwardedHost)?.split(",")[0]?.trim() ??
    requestHeaders.get(REQUEST_HEADERS.host);
  const requestProtocol =
    requestHeaders.get(REQUEST_HEADERS.forwardedProtocol)?.split(",")[0]?.trim() ?? fallbackProtocol;
  return requestOriginMatchesHost(requestOrigin, requestHost, requestProtocol);
}

export function requestCanForwardSessionCookie(
  requestHeaders: Headers,
  apiHostname: string,
  configuredOrigin: string | undefined,
): boolean {
  const publicOrigin = configuredPublicOrigin(configuredOrigin);
  if (publicOrigin !== null) return hostMatchesApiHostname(new URL(publicOrigin).host, apiHostname);

  const requestHost = requestHeaders.get(REQUEST_HEADERS.host);
  return requestHost !== null && hostMatchesApiHostname(requestHost, apiHostname);
}

function hostMatchesApiHostname(host: string, apiHostname: string): boolean {
  try {
    const requestHostname = new URL(`${HTTP_PROTOCOL}://${host}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const normalizedApiHostname = apiHostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (requestHostname === normalizedApiHostname) return true;
    const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);
    return loopbackHosts.has(requestHostname) && loopbackHosts.has(normalizedApiHostname);
  } catch {
    return false;
  }
}
