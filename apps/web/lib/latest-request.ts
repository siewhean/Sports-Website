export class LatestRequestFence {
  private epoch = 0;
  private controller: AbortController | null = null;

  cancel(): void {
    this.epoch += 1;
    this.controller?.abort();
    this.controller = null;
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
    }
  }
}
