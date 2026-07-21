import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";

import { contextLogFields } from "./context.js";
import { sanitizeForTelemetry } from "./sanitize.js";

export const redactedLogPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['set-cookie']",
  "req.headers['x-api-key']",
  "request.headers.authorization",
  "request.headers.cookie",
  "request.headers['set-cookie']",
  "request.headers['x-api-key']",
  "headers.authorization",
  "headers.cookie",
  "headers['set-cookie']",
  "headers['x-api-key']",
  "password",
  "*.password",
  "token",
  "*.token",
  "secret",
  "*.secret",
] as const;

export interface CreateLoggerOptions {
  level: string;
  service: string;
  environment: string;
}

export function createLogger(options: CreateLoggerOptions, destination?: DestinationStream): Logger {
  const config: LoggerOptions = {
    level: options.level,
    base: {
      service: options.service,
      environment: options.environment,
    },
    redact: {
      paths: [...redactedLogPaths],
      censor: "[REDACTED]",
    },
    mixin: () => contextLogFields(),
    hooks: {
      logMethod(arguments_, method) {
        const sanitized = arguments_.map((argument) => sanitizeForTelemetry(argument));
        method.apply(this, sanitized as Parameters<typeof method>);
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination ? pino(config, destination) : pino(config);
}
