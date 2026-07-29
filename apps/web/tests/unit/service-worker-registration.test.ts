import { describe, expect, it, vi } from "vitest";
import {
  availableServiceWorkerContainer,
  registerServiceWorker,
} from "../../components/foundation/ServiceWorkerRegistration";

describe("service-worker registration", () => {
  it("treats a browser-blocked undefined service-worker container as unavailable", () => {
    expect(availableServiceWorkerContainer({ serviceWorker: undefined })).toBeNull();
  });

  it("contains a rejected registration without an unhandled page error", async () => {
    const register = vi.fn().mockRejectedValue(new TypeError("Script /sw.js load failed"));

    await expect(
      registerServiceWorker({ register } as unknown as Pick<ServiceWorkerContainer, "register">),
    ).resolves.toBeNull();
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
  });

  it("treats a browser-blocked registration resolving undefined as unavailable", async () => {
    const register = vi.fn().mockResolvedValue(undefined);

    await expect(
      registerServiceWorker({ register } as unknown as Pick<ServiceWorkerContainer, "register">),
    ).resolves.toBeNull();
  });

  it("returns the registration when the browser creates one", async () => {
    const registration = {} as ServiceWorkerRegistration;
    const register = vi.fn().mockResolvedValue(registration);

    await expect(
      registerServiceWorker({ register } as unknown as Pick<ServiceWorkerContainer, "register">),
    ).resolves.toBe(registration);
  });
});
