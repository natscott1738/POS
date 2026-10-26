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

const ADMIN = { email: 'admin@tigonigrown.com', password: 'ChangeMe!Admin2024' };

test.describe('offline capability', () => {
  // Regression: a reload during an outage dropped a signed-in cashier to the
  // sign-in screen, and signing in needs the server, so the till was unusable
  // until the connection came back.
  test('keeps a signed-in till usable after an offline reload', async ({ page, context }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        const request = indexedDB.deleteDatabase('pos-till');
        request.onsuccess = resolve;
        request.onerror = resolve;
        request.onblocked = resolve;
      });
    });
    await page.reload();

    await page.getByRole('button', { name: 'Email' }).click();
    await page.getByLabel('Email').fill(ADMIN.email);
    await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Set up this till')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Use this till' }).click();
    await expect(page.getByLabel('Scan or search')).toBeVisible({ timeout: 15_000 });
    await waitForServiceWorker(page);

    // Ensure the catalogue snapshot is on this till before disconnecting it.
    await expect.poll(() => page.evaluate(async () => {
      const request = indexedDB.open('pos-till');
      await new Promise<void>((resolve, reject) => {
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      const database = request.result;
      const transaction = database.transaction('variants', 'readonly');
      const count = await new Promise<number>((resolve, reject) => {
        const countRequest = transaction.objectStore('variants').count();
        countRequest.onsuccess = () => resolve(countRequest.result);
        countRequest.onerror = () => reject(countRequest.error);
      });
      database.close();
      return count;
    })).toBeGreaterThan(0);

    // Open and cache a real shift before the outage so the queued sale can be
    // reconciled against the same till after the connection returns.
    const shiftBadge = page.locator('.pill').filter({ hasText: /^(Shift open|No shift open)$/ });
    await expect(shiftBadge).toBeVisible({ timeout: 15_000 });
    const shiftOpenBadge = page.locator('.pill').filter({ hasText: /^Shift open$/ });
    const openShift = page.getByRole('button', { name: 'Open shift' }).first();
    if (!(await shiftOpenBadge.isVisible())) {
      await openShift.click();
      const dialog = page.getByRole('dialog', { name: 'Open shift' });
      await dialog.getByLabel('Opening float').fill('5000');
      await dialog.getByRole('button', { name: 'Open shift' }).click();
      await expect(page.locator('.pill').filter({ hasText: /^Shift open$/ })).toBeVisible();
    }
    await expect.poll(() => page.evaluate(async () => {
      const request = indexedDB.open('pos-till');
      await new Promise<void>((resolve, reject) => {
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      const database = request.result;
      const transaction = database.transaction('meta', 'readonly');
      const rows = await new Promise<Array<{ key: string; value: { shift?: { status?: string } } }>>((resolve, reject) => {
        const read = transaction.objectStore('meta').getAll();
        read.onsuccess = () => resolve(read.result);
        read.onerror = () => reject(read.error);
      });
      database.close();
      return rows.some((row) => row.key.startsWith('shift:') && row.value.shift?.status === 'OPEN');
    })).toBe(true);

    await context.setOffline(true);
    await page.reload();

    await expect(page.getByLabel('Scan or search')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.pill.offline')).toBeVisible();
    // Being offline is shown by the badge; it is not an error to shout about.
    await expect(page.locator('.toast.error')).toHaveCount(0);

    const scan = page.getByLabel('Scan or search');
    await scan.fill('6001234500024');
    await scan.press('Enter');
    await expect(page.getByText('Kenyan AA Coffee 500g').first()).toBeVisible();
    await page.getByRole('button', { name: /Take payment/ }).click();
    const payment = page.getByRole('dialog', { name: 'Payment' });
    await expect(payment.getByRole('button', { name: 'M-PESA' })).toBeDisabled();
    await expect(payment.getByRole('button', { name: 'Card' })).toBeDisabled();
    await payment.getByLabel('Cash received').fill('1200');
    await payment.getByRole('button', { name: 'Add cash payment' }).click();
    await payment.getByRole('button', { name: 'Complete sale' }).click();
    await expect(page.locator('.toast.success').filter({ hasText: 'Sale saved offline' })).toBeVisible();

    const offlineRecords = await page.evaluate(async () => {
      const request = indexedDB.open('pos-till');
      await new Promise<void>((resolve, reject) => {
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      const database = request.result;
      const transaction = database.transaction(['queue', 'sales'], 'readonly');
      const [queue, sales] = await Promise.all([
        new Promise<Array<{ type: string; status: string }>>((resolve, reject) => {
          const read = transaction.objectStore('queue').getAll();
          read.onsuccess = () => resolve(read.result);
          read.onerror = () => reject(read.error);
        }),
        new Promise<Array<{ status: string }>>((resolve, reject) => {
          const read = transaction.objectStore('sales').getAll();
          read.onsuccess = () => resolve(read.result);
          read.onerror = () => reject(read.error);
        }),
      ]);
      database.close();
      return { queue, sales };
    });
    expect(offlineRecords.queue).toContainEqual(expect.objectContaining({ type: 'SALE_CREATE', status: 'PENDING' }));
    expect(offlineRecords.sales).toContainEqual(expect.objectContaining({ status: 'QUEUED' }));

    // Simulate a tab being killed after it claimed the upload. Its expired
    // lease must be reclaimed, and the sale must sync once when service returns.
    await page.evaluate(async () => {
      const request = indexedDB.open('pos-till');
      await new Promise<void>((resolve, reject) => {
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      const database = request.result;
      const transaction = database.transaction('queue', 'readwrite');
      const queue = transaction.objectStore('queue');
      const read = queue.getAll();
      await new Promise<void>((resolve, reject) => {
        read.onsuccess = () => {
          const operation = read.result[0];
          queue.put({ ...operation, status: 'SENDING', attemptStartedAt: Date.now() - 180_000 });
          resolve();
        };
        read.onerror = () => reject(read.error);
      });
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
    });

    await context.setOffline(false);
    await expect.poll(() => page.evaluate(async () => {
      const request = indexedDB.open('pos-till');
      await new Promise<void>((resolve, reject) => {
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      const database = request.result;
      const transaction = database.transaction(['queue', 'sales'], 'readonly');
      const pending = await new Promise<number>((resolve, reject) => {
        const count = transaction.objectStore('queue').count();
        count.onsuccess = () => resolve(count.result);
        count.onerror = () => reject(count.error);
      });
      const sales = await new Promise<Array<{ status: string; receiptNumber: string | null }>>((resolve, reject) => {
        const read = transaction.objectStore('sales').getAll();
        read.onsuccess = () => resolve(read.result);
        read.onerror = () => reject(read.error);
      });
      database.close();
      return { pending, synced: sales.some((sale) => sale.status === 'SYNCED' && Boolean(sale.receiptNumber)) };
    }), { timeout: 30_000 }).toEqual({ pending: 0, synced: true });
  });

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
