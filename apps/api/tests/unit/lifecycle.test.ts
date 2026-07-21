import { describe, expect, it, vi } from "vitest";
import { startServer } from "../../src/lifecycle.js";

describe("API server lifecycle", () => {
  it("closes app-owned Redis and telemetry hooks before surfacing listen failure", async () => {
    const listenError = new Error("address already in use");
    const close = vi.fn(async () => undefined);
    const onListenError = vi.fn();

    await expect(
      startServer({
        close,
        listen: async () => Promise.reject(listenError),
        onListenError,
      }),
    ).rejects.toBe(listenError);

    expect(onListenError).toHaveBeenCalledWith(listenError);
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves the listen error even if cleanup also fails", async () => {
    const listenError = new Error("listen failed");
    const closeError = new Error("cleanup failed");
    const onCloseError = vi.fn();

    await expect(
      startServer({
        close: async () => Promise.reject(closeError),
        listen: async () => Promise.reject(listenError),
        onCloseError,
        onListenError: vi.fn(),
      }),
    ).rejects.toBe(listenError);
    expect(onCloseError).toHaveBeenCalledWith(closeError);
  });
});
