export type GateCC3HeldMode = "hold_request" | "hold_response";

export class GateCC3BoundedBuffer {
  readonly #chunks: Buffer[] = [];
  #bytes = 0;

  constructor(readonly maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new Error("Buffer limit must be a positive integer.");
    }
  }

  append(chunk: Buffer): boolean {
    this.#bytes += chunk.byteLength;
    if (this.#bytes > this.maximumBytes) return false;
    this.#chunks.push(Buffer.from(chunk));
    return true;
  }

  value(): Buffer {
    if (this.#bytes > this.maximumBytes) throw new Error("Buffered response exceeded its limit.");
    return Buffer.concat(this.#chunks);
  }
}

type HeldRequest = {
  clientEventId: string;
  mode: GateCC3HeldMode;
  phase: "armed" | "held";
  release?: () => void;
  timer: ReturnType<typeof setTimeout>;
};

type Divergence = {
  clientEventId: string;
  timer: ReturnType<typeof setTimeout>;
};

export class GateCC3ProxyFaultRegistry {
  readonly #held = new Map<string, HeldRequest>();
  readonly #divergences = new Map<string, Divergence>();

  constructor(readonly ttlMs = 30_000) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error("Fault-control TTL must be a positive integer.");
  }

  armHeld(scope: string, clientEventId: string, mode: GateCC3HeldMode): boolean {
    if (this.#held.has(scope)) return false;
    const timer = setTimeout(() => this.cancelHeld(scope), this.ttlMs);
    timer.unref?.();
    this.#held.set(scope, { clientEventId, mode, phase: "armed", timer });
    return true;
  }

  held(scope: string | undefined): Omit<HeldRequest, "timer"> | undefined {
    if (!scope) return undefined;
    const record = this.#held.get(scope);
    if (!record) return undefined;
    return {
      clientEventId: record.clientEventId,
      mode: record.mode,
      phase: record.phase,
      ...(record.release ? { release: record.release } : {}),
    };
  }

  markHeld(scope: string, release: () => void): boolean {
    const record = this.#held.get(scope);
    if (!record || record.phase !== "armed") return false;
    record.phase = "held";
    record.release = release;
    return true;
  }

  releaseHeld(scope: string): boolean {
    const record = this.#held.get(scope);
    if (!record || record.phase !== "held" || !record.release) return false;
    this.#held.delete(scope);
    clearTimeout(record.timer);
    record.release();
    return true;
  }

  cancelHeld(scope: string): void {
    const record = this.#held.get(scope);
    if (!record) return;
    this.#held.delete(scope);
    clearTimeout(record.timer);
    record.release?.();
  }

  armDivergence(scope: string, clientEventId: string): boolean {
    if (this.#divergences.has(scope)) return false;
    const timer = setTimeout(() => this.cancelDivergence(scope), this.ttlMs);
    timer.unref?.();
    this.#divergences.set(scope, { clientEventId, timer });
    return true;
  }

  consumeDivergence(scope: string | undefined, clientEventId: string | undefined): boolean {
    if (!scope || !clientEventId) return false;
    const record = this.#divergences.get(scope);
    if (!record || record.clientEventId !== clientEventId) return false;
    this.#divergences.delete(scope);
    clearTimeout(record.timer);
    return true;
  }

  hasDivergence(scope: string | undefined): boolean {
    return Boolean(scope && this.#divergences.has(scope));
  }

  cancelDivergence(scope: string): void {
    const record = this.#divergences.get(scope);
    if (!record) return;
    this.#divergences.delete(scope);
    clearTimeout(record.timer);
  }

  hasActive(scope: string | undefined): boolean {
    return Boolean(scope && (this.#held.has(scope) || this.#divergences.has(scope)));
  }

  dispose(): void {
    for (const scope of [...this.#held.keys()]) this.cancelHeld(scope);
    for (const scope of [...this.#divergences.keys()]) this.cancelDivergence(scope);
  }
}
