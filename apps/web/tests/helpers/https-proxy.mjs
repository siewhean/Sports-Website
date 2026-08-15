import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:https";
import { request as httpRequest } from "node:http";

const upstreamPort = Number(process.env.HTTPS_PROXY_UPSTREAM_PORT ?? "3101");
const proxyPort = Number(process.env.HTTPS_PROXY_PORT ?? "3100");

if (!Number.isSafeInteger(upstreamPort) || upstreamPort < 1024 || upstreamPort > 65535) {
  throw new Error("HTTPS_PROXY_UPSTREAM_PORT must be an unprivileged TCP port");
}
if (!Number.isSafeInteger(proxyPort) || proxyPort < 1024 || proxyPort > 65535) {
  throw new Error("HTTPS_PROXY_PORT must be an unprivileged TCP port");
}

// The QA proxy must be ready inside the runner's short startup grace period.
// Generate a throwaway P-256 certificate through files instead of piping a
// freshly generated RSA key through /dev/stdin; the latter is both slower and
// unreliable on hosted Linux OpenSSL builds. These credentials are local-only,
// live for one day and are deleted immediately after being read into memory.
const certificateDirectory = mkdtempSync(join(tmpdir(), "matchday-https-proxy-"));
const keyPath = join(certificateDirectory, "key.pem");
const certificatePath = join(certificateDirectory, "cert.pem");
try {
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-sha256",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
} catch {
  rmSync(certificateDirectory, { recursive: true, force: true });
  throw new Error("Playwright HTTPS proxy could not create its temporary certificate");
}
const key = readFileSync(keyPath);
const certificate = readFileSync(certificatePath);
rmSync(certificateDirectory, { recursive: true, force: true });

const server = createServer({ key, cert: certificate }, (incoming, outgoing) => {
  const upstream = httpRequest(
    {
      hostname: "127.0.0.1",
      port: upstreamPort,
      path: incoming.url,
      method: incoming.method,
      headers: {
        ...incoming.headers,
        // Preserve the browser authority. BFF same-origin checks must observe
        // the HTTPS proxy origin, not the private HTTP upstream.
        host: incoming.headers.host,
        "x-forwarded-host": incoming.headers.host,
        "x-forwarded-proto": "https",
      },
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    },
  );
  upstream.on("error", (error) => {
    outgoing.writeHead(502, { "content-type": "text/plain", "cache-control": "no-store" });
    outgoing.end(`Playwright HTTPS proxy could not reach Next.js: ${error.message}`);
  });
  incoming.pipe(upstream);
});

let closing = false;

function close() {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 1_000).unref();
}

process.once("SIGINT", close);
process.once("SIGTERM", close);
server.listen(proxyPort, "127.0.0.1");
