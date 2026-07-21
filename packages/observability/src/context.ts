import { AsyncLocalStorage } from "node:async_hooks";

export interface ObservabilityContext {
  requestId?: string;
  correlationId?: string;
  jobId?: string;
  traceId?: string;
  spanId?: string;
}

const contextStorage = new AsyncLocalStorage<Readonly<ObservabilityContext>>();

function removeUndefined(context: ObservabilityContext): ObservabilityContext {
  return Object.fromEntries(
    Object.entries(context).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export function getObservabilityContext(): Readonly<ObservabilityContext> {
  return contextStorage.getStore() ?? {};
}

export function runWithObservabilityContext<T>(context: ObservabilityContext, callback: () => T): T {
  const merged = Object.freeze(
    removeUndefined({
      ...getObservabilityContext(),
      ...context,
    }),
  );
  return contextStorage.run(merged, callback);
}

export function bindObservabilityContext<TArguments extends unknown[], TResult>(
  callback: (...arguments_: TArguments) => TResult,
  context: ObservabilityContext = getObservabilityContext(),
): (...arguments_: TArguments) => TResult {
  const captured = { ...context };
  return (...arguments_: TArguments) => runWithObservabilityContext(captured, () => callback(...arguments_));
}

export function contextLogFields(
  context: Readonly<ObservabilityContext> = getObservabilityContext(),
): Record<string, string> {
  return removeUndefined({ ...context }) as Record<string, string>;
}
