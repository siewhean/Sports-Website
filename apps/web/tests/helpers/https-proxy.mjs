import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const upstreamPort = Number(process.env.HTTPS_PROXY_UPSTREAM_PORT ?? "3101");
const proxyPort = Number(process.env.HTTPS_PROXY_PORT ?? "3100");

if (!Number.isSafeInteger(upstreamPort) || upstreamPort < 1024 || upstreamPort > 65535) {
  throw new Error("HTTPS_PROXY_UPSTREAM_PORT must be an unprivileged TCP port");
}
if (!Number.isSafeInteger(proxyPort) || proxyPort < 1024 || proxyPort > 65535) {
  throw new Error("HTTPS_PROXY_PORT must be an unprivileged TCP port");
}

const certificateDirectory = mkdtempSync(path.join(tmpdir(), "matchday-playwright-https-"));
const keyPath = path.join(certificateDirectory, "key.pem");
const certificatePath = path.join(certificateDirectory, "certificate.pem");

try {
  // This throwaway certificate is only for the isolated browser proxy. Generate
  // it in one OpenSSL invocation instead of piping a key through /dev/stdin;
  // the latter is timing/platform-sensitive on hosted Linux runners.
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
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const key = readFileSync(keyPath);
  const certificate = readFileSync(certificatePath);

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
} finally {
  rmSync(certificateDirectory, { recursive: true, force: true });
}
