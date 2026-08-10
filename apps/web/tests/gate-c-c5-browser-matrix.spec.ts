import { activateAndInspectServiceWorker, expect, test } from "./helpers/gate-c-c5-test";

test("C5 browser matrix keeps the public shell service-worker controlled and private routes uncached", async ({
  context,
  page,
}) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator("main")).toBeVisible();
  await activateAndInspectServiceWorker(page, context);

  const cachedPaths = await page.evaluate(async () => {
    const paths: string[] = [];
    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName);
      for (const request of await cache.keys()) paths.push(new URL(request.url).pathname);
    }
    return paths;
  });
  expect(cachedPaths).not.toContain("/");
  expect(cachedPaths).not.toContain("/offline");
  expect(cachedPaths).not.toContain("/organiser");
  expect(cachedPaths).not.toContain("/official");
  expect(cachedPaths).not.toContain("/score");
});
