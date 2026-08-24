import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import net from "node:net";
import test from "node:test";

test("HTTPS proxy generates a certificate, proxies requests, and releases its port", { timeout: 15_000 }, async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("proxied response");
  });
  const upstreamPort = await listen(upstream);
  const proxyPort = await getAvailablePort();
  const proxy = spawn(process.execPath, ["tests/helpers/https-proxy.mjs"], {
    cwd: new URL("../..", import.meta.url),
    env: {
      ...process.env,
      PLAYWRIGHT_NEXT_PORT: String(upstreamPort),
      PLAYWRIGHT_HTTPS_PROXY_PORT: String(proxyPort),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  proxy.stderr.setEncoding("utf8");
  proxy.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const response = await waitForResponse(proxyPort, proxy, () => stderr);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "proxied response");

    proxy.kill("SIGTERM");
    await waitForExit(proxy);
    await waitForPort(proxyPort, false);
  } finally {
    if (proxy.exitCode === null && proxy.signalCode === null) proxy.kill("SIGKILL");
    await waitForExit(proxy);
    await new Promise((resolve) => upstream.close(resolve));
  }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      resolve(address.port);
    });
  });
}

async function getAvailablePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForResponse(port, child, stderr) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      assert.fail(`HTTPS proxy exited before responding: ${stderr()}`);
    }
    try {
      return await request(port);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.fail(`HTTPS proxy did not respond within 10 seconds: ${stderr()}`);
}

function request(port) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      { host: "127.0.0.1", path: "/health", port, rejectUnauthorized: false },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.once("end", () => resolve({ body, statusCode: response.statusCode }));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => child.once("exit", resolve));
}

async function waitForPort(port, expectedOpen) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await canConnect(port)) === expectedOpen) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`port ${port} did not become ${expectedOpen ? "open" : "free"} within 5 seconds`);
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}
