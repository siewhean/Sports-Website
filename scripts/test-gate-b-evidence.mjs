#!/usr/bin/env node

import assert from "node:assert/strict";
import { gateBSecretValues, gateBVerdict, redactGateBEvidence } from "./gate-b-evidence.mjs";

const secrets = gateBSecretValues({
  PUBLIC_VALUE: "visible",
  DATABASE_PASSWORD: "database-password-value",
  API_TOKEN: "api-token-value",
  SHORT_SECRET: "tiny",
});
assert.deepEqual(secrets, ["database-password-value", "api-token-value"]);

const redacted = redactGateBEvidence(
  [
    "database-password-value",
    "API_TOKEN=api-token-value",
    "cookie: browser-cookie-value",
    "Bearer bearer-value",
    "visible",
  ].join("\n"),
  secrets,
);
assert(!redacted.includes("database-password-value"));
assert(!redacted.includes("api-token-value"));
assert(!redacted.includes("browser-cookie-value"));
assert(!redacted.includes("bearer-value"));
assert(redacted.includes("visible"));

const pass = { status: "PASS", exitCode: 0 };
assert.equal(gateBVerdict([pass, pass], 2), "PASS");
assert.equal(gateBVerdict([pass], 2), "FAIL", "Missing checks cannot pass");
assert.equal(gateBVerdict([pass, { status: "SKIPPED", exitCode: null }], 2), "FAIL", "Skipped checks cannot pass");
assert.equal(gateBVerdict([pass, { status: "FAIL", exitCode: 1 }], 2), "FAIL", "Failed checks cannot pass");
assert.equal(gateBVerdict([pass, { status: "PASS", exitCode: 1 }], 2), "FAIL", "Non-zero exit codes cannot pass");
assert.throws(() => gateBVerdict([], 0), /positive integer/i);

process.stdout.write("Gate B evidence self-test passed.\n");
