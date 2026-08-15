import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:https";
import { request as httpRequest } from "node:http";

const upstreamPort = Number(process.env.HTTPS_PROXY_UPSTREAM_PORT ?? "3101");
const proxyPort = Number(process.env.HTTPS_PROXY_PORT ?? "3100");
if (!Number.isSafeInteger(upstreamPort) || upstreamPort < 1024 || upstreamPort > 65535) throw new Error("HTTPS_PROXY_UPSTREAM_PORT must be an unprivileged TCP port");
if (!Number.isSafeInteger(proxyPort) || proxyPort < 1024 || proxyPort > 65535) throw new Error("HTTPS_PROXY_PORT must be an unprivileged TCP port");

const dir = mkdtempSync(join(tmpdir(), "matchday-https-proxy-"));
const keyPath = join(dir, "key.pem");
const certPath = join(dir, "cert.pem");
try {
  execFileSync("openssl", ["req", "-new", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-sha256", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost", "-keyout", keyPath, "-out", certPath], { stdio: ["ignore", "ignore", "ignore"] });
} catch {
  rmSync(dir, { recursive: true, force: true });
  throw new Error("Playwright HTTPS proxy could not create its temporary certificate");
}
const key = readFileSync(keyPath);
const certificate = readFileSync(certPath);
rmSync(dir, { recursive: true, force: true });

const server = createServer({ key, cert: certificate }, (incoming, outgoing) => {
  const upstream = httpRequest({ hostname: "127.0.0.1", port: upstreamPort, path: incoming.url, method: incoming.method, headers: { ...incoming.headers, host: incoming.headers.host, "x-forwarded-host": incoming.headers.host, "x-forwarded-proto": "https" } }, (response) => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
  });
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
