export type MetricAttributeValue = string | number | boolean;
export type MetricAttributes = Readonly<Record<string, MetricAttributeValue>>;

export interface CounterLike {
  add(value: number, attributes?: MetricAttributes): void;
}

export interface HistogramLike {
  record(value: number, attributes?: MetricAttributes): void;
}

export interface UpDownCounterLike {
  add(value: number, attributes?: MetricAttributes): void;
}

export interface MeterLike {
  createCounter(name: string, options?: { description?: string; unit?: string }): CounterLike;
  createHistogram(name: string, options?: { description?: string; unit?: string }): HistogramLike;
  createUpDownCounter(name: string, options?: { description?: string; unit?: string }): UpDownCounterLike;
}

export interface MeterProviderLike {
  getMeter(name: string, version?: string): MeterLike;
}

const noopCounter: CounterLike = { add: () => undefined };
const noopHistogram: HistogramLike = { record: () => undefined };
const noopUpDownCounter: UpDownCounterLike = { add: () => undefined };

function safeCounter(instrument?: CounterLike): CounterLike {
  return {
    add(value, attributes) {
      try {
        instrument?.add(value, attributes);
      } catch {
        // Metrics must not affect the request or job result.
      }
    },
  };
}

function safeHistogram(instrument?: HistogramLike): HistogramLike {
  return {
    record(value, attributes) {
      try {
        instrument?.record(value, attributes);
      } catch {
        // Metrics must not affect the request or job result.
      }
    },
  };
}

function safeUpDownCounter(instrument?: UpDownCounterLike): UpDownCounterLike {
  return {
    add(value, attributes) {
      try {
        instrument?.add(value, attributes);
      } catch {
        // Metrics must not affect the request or job result.
      }
    },
  };
}

export interface MetricsRuntime {
  counter(name: string, options?: { description?: string; unit?: string }): CounterLike;
  histogram(name: string, options?: { description?: string; unit?: string }): HistogramLike;
  upDownCounter(name: string, options?: { description?: string; unit?: string }): UpDownCounterLike;
}

export interface InitializeMetricsOptions {
  serviceName: string;
  serviceVersion?: string;
  provider?: MeterProviderLike;
}

export function initializeMetrics(options: InitializeMetricsOptions): MetricsRuntime {
  let meter: MeterLike | undefined;
  try {
    meter = options.provider?.getMeter(options.serviceName, options.serviceVersion);
  } catch {
    meter = undefined;
  }

  return {
    counter(name, instrumentOptions) {
      try {
        return safeCounter(meter?.createCounter(name, instrumentOptions));
      } catch {
        return noopCounter;
      }
    },
    histogram(name, instrumentOptions) {
      try {
        return safeHistogram(meter?.createHistogram(name, instrumentOptions));
      } catch {
        return noopHistogram;
      }
    },
    upDownCounter(name, instrumentOptions) {
      try {
        return safeUpDownCounter(meter?.createUpDownCounter(name, instrumentOptions));
      } catch {
        return noopUpDownCounter;
      }
    },
  };
}
