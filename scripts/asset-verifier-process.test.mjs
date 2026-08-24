import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import test from "node:test";
import { terminateChildTree } from "./asset-verifier-process.mjs";

const port = 3217;

test("asset verifier cleanup releases port 3217 after its origin process succeeds", { timeout: 10_000 }, async () => {
  await assertPortFree();
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import http from \"node:http\"; http.createServer((_request, response) => response.end(\"ok\")).listen(${port}, \"127.0.0.1\");`,
    ],
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    await waitForPort(port, true);
    await terminateChildTree(child);
    await waitForPort(port, false);
    assert.ok(child.exitCode !== null || child.signalCode !== null, "origin child did not exit after verifier cleanup");
  } finally {
    await terminateChildTree(child);
  }
});

async function assertPortFree() {
  const occupied = await canConnect(port);
  assert.equal(occupied, false, `port ${port} must be free before the cleanup regression test begins`);
}

async function waitForPort(targetPort, expectedOpen) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await canConnect(targetPort)) === expectedOpen) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`port ${targetPort} did not become ${expectedOpen ? "open" : "free"} within 5 seconds`);
}

function canConnect(targetPort) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: targetPort });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}
