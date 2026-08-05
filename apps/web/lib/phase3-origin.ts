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
