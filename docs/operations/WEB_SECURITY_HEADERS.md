# Web security-header ownership

The Next.js request proxy in `apps/web/proxy.ts` is the application source of truth for HTML security headers. It generates a fresh nonce per request, forwards the nonce to the App Router through `x-nonce`, and emits the CSP, cross-origin isolation, permissions, referrer, MIME-sniffing, and frame-denial policies. The CSP `script-src` includes both the request nonce and `'strict-dynamic'`.

Development adds `'unsafe-eval'` only because the React development runtime uses it for debugging. Production never includes that source.

`Strict-Transport-Security` is emitted only when `NODE_ENV=production`, because local HTTP development must remain usable. Public TLS is owned by ingress; ingress and CDN configuration must preserve the origin header unchanged and must not replace the nonce-bearing CSP with a static policy.

`apps/web/next.config.ts` owns the non-security deployment identity header, `X-Matchday-Build-Id`, for every route. It is deliberately separate from the request proxy so immutable assets and API responses can also be bound to the signed-off build manifest.

## Release checks

1. Run the production web build behind HTTPS.
2. Verify the full header set on representative public, organiser, scorer, 404, and static-asset routes.
3. Confirm each HTML response has a distinct CSP nonce and every framework script uses that nonce.
4. Confirm the CDN preserves CSP, HSTS, frame, content-type, referrer, permissions, cross-origin, and build-ID headers.
5. Treat the local self-signed Playwright proxy as application-header evidence only; certificate-chain validation requires a staging origin with a trusted certificate.
