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
