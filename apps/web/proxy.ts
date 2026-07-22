import { NextRequest, NextResponse } from "next/server";

function createNonce() {
  return btoa(crypto.randomUUID());
}

function requestUsesHttps(request: NextRequest) {
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase();
  if (forwardedProtocol === "http" || forwardedProtocol === "https") return forwardedProtocol === "https";
  return request.nextUrl.protocol === "https:";
}

function contentSecurityPolicy(nonce: string, useTransportSecurity: boolean) {
  const developmentEval = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self'",
    "font-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${developmentEval}`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self'",
    ...(useTransportSecurity ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const nonce = createNonce();
  const useTransportSecurity = requestUsesHttps(request);
  const csp = contentSecurityPolicy(nonce, useTransportSecurity);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy", csp);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  if (useTransportSecurity) {
    response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  }
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico|sw.js).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
