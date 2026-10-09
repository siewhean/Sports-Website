import { parseSentryDsn, type ParsedSentryDsn } from "./sentry-config";

// Same-origin Sentry tunnel. The CSP stays `connect-src 'self'`; the browser SDK
// posts envelopes here and we forward them to the one configured project only.
const MAX_ENVELOPE_BYTES = 256 * 1024;
const FORWARD_TIMEOUT_MS = 5_000;

function configuredTargets(): ParsedSentryDsn[] {
  return [process.env.NEXT_PUBLIC_SENTRY_DSN, process.env.SENTRY_DSN]
    .map(parseSentryDsn)
    .filter((dsn): dsn is ParsedSentryDsn => dsn !== undefined);
}

function respond(status: number) {
  return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const targets = configuredTargets();
  if (targets.length === 0) return respond(404);

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_ENVELOPE_BYTES) return respond(413);

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength === 0) return respond(400);
  if (body.byteLength > MAX_ENVELOPE_BYTES) return respond(413);

  // The envelope header (first line) names the DSN the SDK used.
  const newline = body.indexOf(10);
  const headerBytes = newline === -1 ? body : body.subarray(0, newline);
  let envelopeDsn: ParsedSentryDsn | undefined;
  try {
    const header = JSON.parse(new TextDecoder().decode(headerBytes)) as { dsn?: unknown };
    envelopeDsn = typeof header.dsn === "string" ? parseSentryDsn(header.dsn) : undefined;
  } catch {
    return respond(400);
  }
  if (!envelopeDsn) return respond(400);

  const target = targets.find(
    (candidate) =>
      candidate.host === envelopeDsn.host &&
      candidate.projectId === envelopeDsn.projectId &&
      candidate.publicKey === envelopeDsn.publicKey,
  );
  if (!target) return respond(403);

  try {
    // Cookies, authorization and client-IP headers are deliberately not forwarded.
    const upstream = await fetch(`${target.protocol}//${target.host}/api/${target.projectId}/envelope/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    return respond(upstream.ok ? 200 : 502);
  } catch {
    return respond(502);
  }
}
