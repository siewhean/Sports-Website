# System response status boundary

- Unknown App Router paths use `app/not-found.tsx`; Next.js owns the response and returns HTTP 404. The Playwright system-page flow asserts both the status and recovery UI.
- `app/error.tsx` and `app/global-error.tsx` are runtime error boundaries, not addressable error routes. Next.js or the hosting runtime owns the HTTP 500 status; an error discovered after streaming has begun cannot retroactively change the response status.
- `/maintenance` is a reachable preview and recovery destination, so its page response is intentionally HTTP 200 even though the UI identifies the intended service state as 503. A real maintenance response must be emitted by the edge/load-balancer maintenance switch before routing or streaming begins, while serving the same recovery copy. The Playwright flow locks the preview boundary to 200 to prevent the UI from being mistaken for transport-level 503 handling.

Do not simulate HTTP 500 or 503 by adding public throw-only routes. Production status verification belongs at the deployment edge where those responses are created.
