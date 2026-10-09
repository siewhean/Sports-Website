import { NextRequest, NextResponse } from "next/server";
import { isPublicDocumentPath, PUBLIC_DOCUMENT_HEADER, PUBLIC_READ_FRESHNESS_HEADER } from "@/lib/public-routes";

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

/*
 * CSP design: every HTML route keeps a per-request nonce + 'strict-dynamic' (no 'unsafe-inline' scripts). Next 16
 * App Router streams the RSC payload as inline <script>self.__next_f.push(...)</script> tags whose content changes
 * with the data, so a cached/prerendered HTML document cannot satisfy a strict CSP (hash/SRI only covers external
 * chunks). Public pages therefore stay request-rendered; their cost is cut instead by the Data Cache for public
 * reads (lib/phase2-public.server.ts), the sin1 function region next to the API (vercel.json), and the CDN-cached
 * JSON snapshot route for live updates (/api/public/competitions/:slug/snapshot, outside this matcher).
 */
export function proxy(request: NextRequest) {
  const nonce = createNonce();
  const useTransportSecurity = requestUsesHttps(request);
  const csp = contentSecurityPolicy(nonce, useTransportSecurity);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy", csp);
  requestHeaders.set("x-nonce", nonce);
  // Always overwritten so a browser cannot choose the value directly. An RSC request (router.refresh() after a
  // live version event, or a client navigation) must see the newest publication, so it bypasses the Data Cache.
  requestHeaders.set(PUBLIC_READ_FRESHNESS_HEADER, request.headers.has("rsc") ? "live" : "cached");

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  if (isPublicDocumentPath(request.nextUrl.pathname)) response.headers.set(PUBLIC_DOCUMENT_HEADER, "1");
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
