import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "artifacts/deployment-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert(typeof manifest.buildId === "string" && manifest.buildId.length > 0, "Manifest build ID is missing");
assert(Array.isArray(manifest.assets) && manifest.assets.length > 0, "Manifest has no static assets");
assert(manifest.assetCount === manifest.assets.length, "Manifest asset count does not match its asset list");
const manifestAssets = new Map(manifest.assets.map((asset) => [asset.path, asset]));
assert(manifestAssets.size === manifest.assets.length, "Manifest contains duplicate asset paths");
const configuredBaseUrl = process.env.ASSET_VERIFY_BASE_URL;
const baseUrl = configuredBaseUrl ?? "http://127.0.0.1:3217";
const baseProtocol = new URL(baseUrl).protocol;
const requestTimeoutMs = 10_000;
let child;

try {
  if (configuredBaseUrl === undefined) {
    child = spawn("pnpm", ["--filter", "@matchday/web", "start", "--hostname", "127.0.0.1", "--port", "3217"], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    await waitUntilReady(baseUrl, child, () => output);
  }

  const home = await fetchChecked(`${baseUrl}/`);
  assert(
    home.headers.get("x-matchday-build-id") === manifest.buildId,
    `Running origin build ${home.headers.get("x-matchday-build-id") ?? "(missing)"} does not match manifest build ${manifest.buildId}`,
  );
  const html = await home.text();
  const assetPath = html.match(/\/_next\/static\/[^"']+\.js/u)?.[0];
  assert(assetPath !== undefined, "Home page did not reference a Next.js JavaScript asset");
  assert(manifestAssets.has(assetPath), `Served asset ${assetPath} is missing from deployment manifest`);

  for (const manifestAsset of manifest.assets) {
    await verifyManifestAsset(baseUrl, manifestAsset);
  }

  const asset = await fetchChecked(`${baseUrl}${assetPath}`, {
    headers: { "accept-encoding": "br, gzip" },
  });
  const cacheControl = asset.headers.get("cache-control") ?? "";
  assert(/public/iu.test(cacheControl), "Static asset is not public-cacheable");
  assert(/max-age=31536000/iu.test(cacheControl), "Static asset is missing the one-year max-age");
  assert(/immutable/iu.test(cacheControl), "Static asset is not immutable");
  assert(
    (asset.headers.get("vary") ?? "").toLowerCase().includes("accept-encoding"),
    "Static asset does not vary on Accept-Encoding",
  );
  assert(asset.headers.get("content-encoding") === "gzip", "Origin did not negotiate gzip for a JavaScript asset");
  const etag = asset.headers.get("etag");
  assert(etag !== null && etag.length > 0, "Static asset is missing an ETag");
  const compressedResponseBytes = Buffer.from(await asset.arrayBuffer());
  assertAssetBytes(manifestAssets.get(assetPath), compressedResponseBytes);

  const conditionalStatus = await requestStatus(`${baseUrl}${assetPath}`, {
    "accept-encoding": "br, gzip",
    "if-none-match": etag,
  });
  assert(conditionalStatus === 304, `Conditional asset request returned ${conditionalStatus}, expected 304`);

  for (const privatePath of ["/organiser", "/official", "/score"]) {
    const response = await fetchChecked(`${baseUrl}${privatePath}`);
    const policy = response.headers.get("cache-control") ?? "";
    assert(/private/iu.test(policy) && /no-store/iu.test(policy), `${privatePath} is not private and no-store`);
    assert(!/immutable/iu.test(policy), `${privatePath} must never be immutable`);
    for (const header of [
      "content-security-policy",
      "x-content-type-options",
      "x-frame-options",
      "referrer-policy",
      "permissions-policy",
    ]) {
      assert(response.headers.has(header), `${privatePath} is missing ${header}`);
    }
    if (baseProtocol === "https:") {
      assert(response.headers.has("strict-transport-security"), `${privatePath} is missing strict-transport-security`);
    } else {
      assert(
        !response.headers.has("strict-transport-security"),
        `${privatePath} must not advertise strict-transport-security over HTTP`,
      );
    }
    await response.body?.cancel();
  }

  for (const demoOnlyPath of ["/setup", "/format"]) {
    const status = await requestStatus(`${baseUrl}${demoOnlyPath}`);
    assert(status === 404, `${demoOnlyPath} returned ${status}; demo-only routes must be absent from production`);
  }

  const serviceWorker = await fetchChecked(`${baseUrl}/sw.js`);
  assert(!/immutable/iu.test(serviceWorker.headers.get("cache-control") ?? ""), "Service worker must not be immutable");
  await serviceWorker.body?.cancel();
  console.log(`Origin asset delivery verified for build ${manifest.buildId} (${manifest.assetCount} assets)`);
} finally {
  await terminateChildTree(child);
}

async function fetchChecked(url, init) {
  const response = await fetch(url, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(requestTimeoutMs),
  });
  assert(response.ok, `${url} returned ${response.status}`);
  return response;
}

async function verifyManifestAsset(origin, manifestAsset) {
  assert(
    typeof manifestAsset.path === "string" && manifestAsset.path.startsWith("/_next/static/"),
    "Manifest contains an invalid static asset path",
  );
  assert(
    Number.isSafeInteger(manifestAsset.bytes) && manifestAsset.bytes >= 0,
    `${manifestAsset.path} has invalid size`,
  );
  assert(/^[a-f0-9]{64}$/u.test(manifestAsset.sha256), `${manifestAsset.path} has an invalid SHA-256 digest`);

  const response = await fetchChecked(`${origin}${manifestAsset.path}`, {
    headers: { "accept-encoding": "identity" },
  });
  const cacheControl = response.headers.get("cache-control") ?? "";
  assert(/public/iu.test(cacheControl), `${manifestAsset.path} is not public-cacheable`);
  assert(/max-age=31536000/iu.test(cacheControl), `${manifestAsset.path} is missing the one-year max-age`);
  assert(/immutable/iu.test(cacheControl), `${manifestAsset.path} is not immutable`);
  assertAssetBytes(manifestAsset, Buffer.from(await response.arrayBuffer()));
}

function assertAssetBytes(manifestAsset, bytes) {
  assert(bytes.byteLength === manifestAsset.bytes, `${manifestAsset.path} byte size does not match the manifest`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert(digest === manifestAsset.sha256, `${manifestAsset.path} SHA-256 does not match the manifest`);
}

async function waitUntilReady(url, childProcess, getOutput) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (childProcess.exitCode !== null) throw new Error(`Web server exited before readiness:\n${getOutput()}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
    } catch {
      // The server may still be binding its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}:\n${getOutput()}`);
}

async function terminateChildTree(childProcess) {
  if (childProcess === undefined) return;

  if (childProcess.exitCode === null) {
    signalChildTree(childProcess, "SIGTERM");
    await waitForExit(childProcess, 5_000);
  }
  if (childProcess.exitCode === null) {
    signalChildTree(childProcess, "SIGKILL");
    await waitForExit(childProcess, 1_000);
  }

  childProcess.stdout?.destroy();
  childProcess.stderr?.destroy();
}

function signalChildTree(childProcess, signal) {
  if (process.platform !== "win32" && childProcess.pid !== undefined) {
    try {
      process.kill(-childProcess.pid, signal);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }

  if (childProcess.exitCode === null) childProcess.kill(signal);
}

async function waitForExit(childProcess, timeoutMs) {
  if (childProcess.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => childProcess.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requestStatus(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const request = client.get(parsed, { headers }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.setTimeout(requestTimeoutMs, () => {
      request.destroy(new Error(`Timed out requesting ${url} after ${requestTimeoutMs}ms`));
    });
    request.on("error", reject);
  });
}
