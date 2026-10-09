import { test, expect, type Page } from '@playwright/test';

/**
 * Proves the promise the README makes: a till keeps working when the network
 * does not.
 *
 * The critical case is not "a queued sale syncs later" — that is already covered
 * by the API tests. It is that the *application itself* still loads with no
 * connectivity, because a cashier who reloads during an outage must not be met
 * with a blank page.
 */

async function waitForServiceWorker(page: Page): Promise<void> {
  await page.waitForFunction(
    () => navigator.serviceWorker?.controller !== null || navigator.serviceWorker?.ready !== undefined,
    undefined,
    { timeout: 20_000 },
  );
  // Give the precache a moment to finish writing before cutting the network.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForTimeout(1500);
}

test.describe('offline capability', () => {
  test('registers a service worker and precaches the app shell', async ({ page }) => {
    await page.goto('/');
    await waitForServiceWorker(page);

    const registered = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return Boolean(registration?.active);
    });
    expect(registered).toBe(true);

    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      let total = 0;
      for (const name of names) {
        const cache = await caches.open(name);
        total += (await cache.keys()).length;
      }
      return { names, total };
    });

    expect(cached.names.length).toBeGreaterThan(0);
    // The shell, its JS/CSS chunks, icons and the manifest.
    expect(cached.total).toBeGreaterThanOrEqual(5);
  });

  test('loads with the network completely offline', async ({ page, context }) => {
    await page.goto('/');
    await waitForServiceWorker(page);

    // Hard offline: no server, no DNS, nothing.
    await context.setOffline(true);

    await page.reload();

    // The app must render rather than showing a browser error page.
    await expect(page.locator('#root')).not.toBeEmpty({ timeout: 15_000 });
    const text = await page.locator('#root').innerText();
    expect(text.length).toBeGreaterThan(0);
    // The sign-in screen is what an offline till should land on.
    expect(text).toMatch(/Backyard POS|Till PIN|Email|Starting/i);

    await context.setOffline(false);
  });

  test('keeps IndexedDB data across an offline reload', async ({ page, context }) => {
    await page.goto('/');
    await waitForServiceWorker(page);

    // Write through the same Dexie database the till uses for its queue.
    await page.evaluate(async () => {
      const request = indexedDB.open('pos-till');
      await new Promise((resolve, reject) => {
        request.onsuccess = resolve;
        request.onerror = reject;
        request.onupgradeneeded = resolve;
      });
      const db = request.result;
      if (!db.objectStoreNames.contains('meta')) return;
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({ key: 'e2e-marker', value: 'survived' });
      await new Promise((resolve) => { tx.oncomplete = resolve; });
      db.close();
    });

    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('#root')).not.toBeEmpty();

    const survived = await page.evaluate(async () => {
      const request = indexedDB.open('pos-till');
      await new Promise((resolve, reject) => {
        request.onsuccess = resolve;
        request.onerror = reject;
      });
      const db = request.result;
      if (!db.objectStoreNames.contains('meta')) return null;
      const tx = db.transaction('meta', 'readonly');
      const get = tx.objectStore('meta').get('e2e-marker');
      const row = await new Promise<{ value?: string } | undefined>((resolve) => {
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => resolve(undefined);
      });
      db.close();
      return row?.value ?? null;
    });

    expect(survived).toBe('survived');
    await context.setOffline(false);
  });

  test('never serves a cached API response', async ({ page }) => {
    await page.goto('/');
    await waitForServiceWorker(page);

    // Stale prices or stock would be worse than an honest failure, so API
    // responses must not be in any cache.
    const apiEntries = await page.evaluate(async () => {
      const names = await caches.keys();
      const urls: string[] = [];
      for (const name of names) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) urls.push(request.url);
      }
      return urls.filter((u) => u.includes('/api/'));
    });

    expect(apiEntries).toEqual([]);
  });

  test('is installable as an app', async ({ page }) => {
    const response = await page.goto('/manifest.webmanifest');
    expect(response?.status()).toBe(200);

    const manifest = await response?.json();
    expect(manifest.name).toBeTruthy();
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
  });
});
