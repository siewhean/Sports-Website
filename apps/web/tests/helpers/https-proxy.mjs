import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { request as httpRequest } from "node:http";

const key = execFileSync("openssl", ["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048"], {
  stdio: ["ignore", "pipe", "ignore"],
});
const certificate = execFileSync(
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
    "/dev/stdin",
  ],
  { input: key, stdio: ["pipe", "pipe", "ignore"] },
);

const server = createServer({ key, cert: certificate }, (incoming, outgoing) => {
  const upstream = httpRequest(
    {
      hostname: "127.0.0.1",
      port: 3101,
      path: incoming.url,
      method: incoming.method,
      headers: { ...incoming.headers, host: "127.0.0.1:3101", "x-forwarded-proto": "https" },
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
server.listen(3100, "127.0.0.1");
