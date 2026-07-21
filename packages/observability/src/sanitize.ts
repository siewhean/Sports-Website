const redactedValue = "[REDACTED]";
const accessorValue = "[Accessor omitted]";
const uninspectableValue = "[Uninspectable]";

const exactSensitiveKeys = new Set([
  "address",
  "cookie",
  "credentials",
  "dob",
  "email",
  "mobile",
  "passphrase",
  "passwd",
  "password",
  "phone",
  "secret",
  "token",
]);

const sensitiveKeyFragments = [
  "accesstoken",
  "apikey",
  "authorization",
  "bearertoken",
  "clientsecret",
  "credential",
  "dateofbirth",
  "idtoken",
  "password",
  "privatekey",
  "refreshtoken",
  "residentialaddress",
  "sessiontoken",
  "setcookie",
  "streetaddress",
  "xapikey",
  "xauthtoken",
] as const;

function compactKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

export function isSensitiveTelemetryKey(key: string): boolean {
  const compact = compactKey(key);
  return (
    exactSensitiveKeys.has(compact) ||
    sensitiveKeyFragments.some((fragment) => compact.includes(fragment)) ||
    compact.endsWith("secret") ||
    (compact.endsWith("token") && compact !== "tokencount") ||
    compact.endsWith("phone") ||
    compact.endsWith("email")
  );
}

export function sanitizeTelemetryText(text: string): string {
  return text
    .replaceAll(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replaceAll(
      /\b(password|passwd|passphrase|token|secret|api[ _-]?key|authorization|cookie)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[REDACTED]",
    )
    .replaceAll(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, redactedValue)
    .replaceAll(/:\/\/[^\s/:@]+:[^\s/@]+@/g, "://[REDACTED]@")
    .replaceAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]");
}

function propertyDescriptors(value: object): Record<string, PropertyDescriptor> | undefined {
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return undefined;
  }
}

function dataProperty(value: object, key: string): unknown {
  let cursor: object | null = value;
  while (cursor) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(cursor, key);
      cursor = Object.getPrototypeOf(cursor) as object | null;
    } catch {
      return uninspectableValue;
    }
    if (!descriptor) continue;
    return "value" in descriptor ? descriptor.value : accessorValue;
  }
  return undefined;
}

function sanitizeError(error: Error, seen: WeakSet<object>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  const name = dataProperty(error, "name");
  const message = dataProperty(error, "message");
  const stack = dataProperty(error, "stack");
  sanitized.name = typeof name === "string" ? sanitizeTelemetryText(name) : "Error";
  sanitized.message = typeof message === "string" ? sanitizeTelemetryText(message) : uninspectableValue;
  if (typeof stack === "string") sanitized.stack = sanitizeTelemetryText(stack);

  const descriptors = propertyDescriptors(error);
  if (!descriptors) return { name: "Error", message: uninspectableValue };
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "name" || key === "message" || key === "stack") continue;
    sanitized[key] = isSensitiveTelemetryKey(key)
      ? redactedValue
      : "value" in descriptor
        ? sanitizeForTelemetry(descriptor.value, seen)
        : accessorValue;
  }
  return sanitized;
}

export function sanitizeForTelemetry(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return sanitizeTelemetryText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  try {
    if (value instanceof Error) return sanitizeError(value, seen);
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return `[Buffer ${value.byteLength} bytes]`;
  } catch {
    return uninspectableValue;
  }

  const descriptors = propertyDescriptors(value);
  if (!descriptors) return uninspectableValue;
  const output: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) continue;
    const item = isSensitiveTelemetryKey(key)
      ? redactedValue
      : "value" in descriptor
        ? sanitizeForTelemetry(descriptor.value, seen)
        : accessorValue;
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      value: item,
      writable: true,
    });
  }
  return output;
}

export function sanitizeExceptionForTelemetry(error: unknown): unknown {
  try {
    if (!(error instanceof Error)) return sanitizeForTelemetry(error);
  } catch {
    return uninspectableValue;
  }
  const sanitized = sanitizeForTelemetry(error);
  if (!sanitized || typeof sanitized !== "object") return sanitized;
  const values = sanitized as Record<string, unknown>;
  const clean = new Error(typeof values.message === "string" ? values.message : uninspectableValue);
  clean.name = typeof values.name === "string" ? values.name : "Error";
  if (typeof values.stack === "string") clean.stack = values.stack;
  for (const [key, value] of Object.entries(values)) {
    if (key === "name" || key === "message" || key === "stack") continue;
    Object.defineProperty(clean, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  return clean;
}

export const TELEMETRY_REDACTED_VALUE = redactedValue;
