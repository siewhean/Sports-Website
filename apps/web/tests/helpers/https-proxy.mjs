import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

function resolvePort(value, fallback, name) {
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error(`${name} must be an integer TCP port between 1024 and 65535`);
  }
  return port;
}

const upstreamPort = resolvePort(process.env.PLAYWRIGHT_NEXT_PORT, 3101, "PLAYWRIGHT_NEXT_PORT");
const httpsProxyPort = resolvePort(process.env.PLAYWRIGHT_HTTPS_PROXY_PORT, 3100, "PLAYWRIGHT_HTTPS_PROXY_PORT");

function generateCertificate() {
  const directory = mkdtempSync(join(tmpdir(), "matchday-playwright-https-"));
  const keyPath = join(directory, "key.pem");
  const certificatePath = join(directory, "certificate.pem");

  try {
    execFileSync("openssl", ["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", keyPath], {
      stdio: "ignore",
    });
    execFileSync(
      "openssl",
      [
        "req",
        "-new",
        "-x509",
        "-sha256",
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
        "-key",
        keyPath,
        "-out",
        certificatePath,
      ],
      { stdio: "ignore" },
    );
    return { key: readFileSync(keyPath), certificate: readFileSync(certificatePath) };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

const { key, certificate } = generateCertificate();

const server = createServer({ key, cert: certificate }, (incoming, outgoing) => {
  const upstream = httpRequest(
    {
      hostname: "127.0.0.1",
      port: upstreamPort,
      path: incoming.url,
      method: incoming.method,
      headers: { ...incoming.headers, host: `127.0.0.1:${upstreamPort}`, "x-forwarded-proto": "https" },
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
server.listen(httpsProxyPort, "127.0.0.1");
