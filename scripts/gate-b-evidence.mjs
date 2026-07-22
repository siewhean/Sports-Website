const secretNamePattern = /(secret|token|password|credential|cookie|private.?key|api.?key|bearer)/i;

export function gateBSecretValues(environment) {
  return Object.entries(environment)
    .filter(([name, value]) => secretNamePattern.test(name) && typeof value === "string" && value.length >= 6)
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);
}

export function redactGateBEvidence(value, secrets = []) {
  let redacted = String(value);
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    if (secret.length >= 6) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted.replace(
    /((?:secret|token|password|credential|cookie|private[_-]?key|api[_-]?key|bearer)[A-Za-z0-9_.-]*\s*[=:]\s*)([^\s,;]+)/gi,
    "$1[REDACTED]",
  );
}

export function gateBVerdict(results, requiredCount) {
  if (!Number.isSafeInteger(requiredCount) || requiredCount < 1) {
    throw new Error("requiredCount must be a positive integer");
  }
  if (!Array.isArray(results) || results.length !== requiredCount) return "FAIL";
  return results.every((result) => result?.status === "PASS" && result.exitCode === 0) ? "PASS" : "FAIL";
}
