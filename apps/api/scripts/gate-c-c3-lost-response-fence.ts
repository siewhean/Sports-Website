const CLIENT_EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type Fence = { clientEventId: string; expiresAt: number; phase: "armed" | "response_dropped" };

export class GateCC3LostResponseFence {
  readonly #fences = new Map<string, Fence>();

  constructor(private readonly lifetimeMs = 30_000) {}

  arm(scope: string, clientEventId: string, now: number): boolean {
    this.#prune(now);
    if (!scope || !CLIENT_EVENT_ID.test(clientEventId) || this.#fences.has(scope)) return false;
    this.#fences.set(scope, {
      clientEventId,
      expiresAt: now + this.lifetimeMs,
      phase: "armed",
    });
    return true;
  }

  hasActive(scope: string | undefined, now: number): boolean {
    this.#prune(now);
    return scope ? this.#fences.has(scope) : false;
  }

  handle(input: {
    scope?: string;
    path: string;
    clientEventId?: string;
    now: number;
  }): "allow" | "destroy" | "drop_response" {
    this.#prune(input.now);
    const scope = input.scope;
    const active = scope ? this.#fences.get(scope) : undefined;
    if (!scope || !active) return "allow";
    if (input.path === "/api/scoring/session") return "destroy";
    if (input.path !== "/api/scoring/events") return "allow";
    if (input.clientEventId !== active.clientEventId) return "destroy";
    if (active.phase === "armed") {
      active.phase = "response_dropped";
      return "drop_response";
    }
    this.#fences.delete(scope);
    return "allow";
  }

  #prune(now: number): void {
    for (const [scope, fence] of this.#fences) {
      if (fence.expiresAt <= now) this.#fences.delete(scope);
    }
  }
}
