import { describe, expect, it, vi } from "vitest";
import { registerServiceWorker } from "../../components/foundation/ServiceWorkerRegistration";

describe("service-worker registration", () => {
  it("contains a rejected registration without an unhandled page error", async () => {
    const register = vi.fn().mockRejectedValue(new TypeError("Script /sw.js load failed"));

    await expect(
      registerServiceWorker({ register } as unknown as Pick<ServiceWorkerContainer, "register">),
    ).resolves.toBeUndefined();
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
  });

  it("does not invent success state when registration resolves", async () => {
    const register = vi.fn().mockResolvedValue({});

    await expect(
      registerServiceWorker({ register } as unknown as Pick<ServiceWorkerContainer, "register">),
    ).resolves.toBeUndefined();
  });
});
