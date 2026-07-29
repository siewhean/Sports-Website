export class LatestRequestFence {
  private epoch = 0;
  private controller: AbortController | null = null;
  private readonly idleWaiters = new Set<() => void>();

  private settleIdle(): void {
    if (this.controller) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  cancel(): void {
    this.epoch += 1;
    this.controller?.abort();
    this.controller = null;
    this.settleIdle();
  }

  waitForIdle(): Promise<void> {
    if (!this.controller) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  async run<T>(load: (signal: AbortSignal) => Promise<T>, commit: (value: T) => void): Promise<void> {
    this.cancel();
    const epoch = this.epoch;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const value = await load(controller.signal);
      if (this.epoch === epoch && !controller.signal.aborted) commit(value);
    } catch (error) {
      if (controller.signal.aborted || this.epoch !== epoch) return;
      throw error;
    } finally {
      if (this.epoch === epoch && this.controller === controller) this.controller = null;
      this.settleIdle();
    }
  }
}
