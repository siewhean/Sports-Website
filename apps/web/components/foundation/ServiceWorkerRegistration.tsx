"use client";

import { useEffect } from "react";

type ServiceWorkerRegistrar = Pick<ServiceWorkerContainer, "register">;

export async function registerServiceWorker(registrar: ServiceWorkerRegistrar): Promise<void> {
  try {
    await registrar.register("/sw.js", { scope: "/" });
  } catch {
    // Offline support is progressive enhancement. Navigation or teardown may
    // cancel registration, and that rejection must not escape as a page error.
  }
}

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      void registerServiceWorker(navigator.serviceWorker);
    }
  }, []);

  return null;
}
