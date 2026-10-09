import { test, expect } from '@playwright/test';

/**
 * Shop-floor speed features: holding a basket, the quantity multiplier, and
 * keyboard shortcuts. These exist because a busy counter cannot wait for a
 * customer who has gone back for something, and because scanning one item three
 * times is slower than typing "3*".
 */

const ADMIN = { email: 'admin@tigonigrown.com', password: 'ChangeMe!Admin2024' };
const COFFEE = '6001234500024';

async function signInAndOpenTill(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(
    () => new Promise((r) => {
      const q = indexedDB.deleteDatabase('pos-till');
      q.onsuccess = r; q.onerror = r; q.onblocked = r;
    }),
  );
  await page.reload();
  await page.getByRole('button', { name: 'Email' }).click();
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Use this till' }).click();
  await expect(page.getByLabel('Scan or search')).toBeVisible({ timeout: 15_000 });
  for (const toast of await page.locator('.toast').all()) {
    await toast.click({ timeout: 1000 }).catch(() => {});
  }
}

test.describe('shop floor', () => {
  test('holds a basket and resumes it later', async ({ page }) => {
    await signInAndOpenTill(page);
    const scan = page.getByLabel('Scan or search');

    await scan.fill(COFFEE);
    await scan.press('Enter');
    await expect(page.getByRole('button', { name: /Take payment/ })).toContainText('1,200.00');

    // Customer has gone back for something; the queue cannot wait.
    await page.getByRole('button', { name: 'Hold', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Hold this basket' });
    await dialog.getByLabel('Reference').fill('Mrs Wanjiru');
    await dialog.getByRole('button', { name: 'Hold basket' }).click();

    // Till is free for the next customer.
    await expect(page.getByText('Empty')).toBeVisible();
    await expect(page.getByRole('button', { name: /Held · 1/ })).toBeVisible();

    // Serve someone else in between.
    await scan.fill(COFFEE);
    await scan.press('Enter');
    await expect(page.getByRole('button', { name: /Take payment/ })).toContainText('1,200.00');
    await page.getByRole('button', { name: 'Clear' }).click();

    // Bring the held basket back.
    await page.getByRole('button', { name: /Held · 1/ }).click();
    const held = page.getByRole('dialog', { name: 'Held baskets' });
    await expect(held.getByText('Mrs Wanjiru')).toBeVisible();
    await held.getByRole('button', { name: 'Resume' }).click();

    await expect(page.getByRole('button', { name: /Take payment/ })).toContainText('1,200.00');
    await expect(page.getByText('Kenyan AA Coffee 500g').first()).toBeVisible();
  });

  test('a held basket survives a page reload', async ({ page }) => {
    await signInAndOpenTill(page);
    const scan = page.getByLabel('Scan or search');

    await scan.fill(COFFEE);
    await scan.press('Enter');
    await page.getByRole('button', { name: 'Hold', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Reference').fill('Survives reload');
    await page.getByRole('dialog').getByRole('button', { name: 'Hold basket' }).click();
    await expect(page.getByRole('button', { name: /Held · 1/ })).toBeVisible();

    // A till gets reloaded, closed, or power-cycled. The basket must still be there.
    await page.reload();
    await expect(page.getByRole('button', { name: /Held · 1/ })).toBeVisible({ timeout: 15_000 });
  });

  test('sells three of an item with the quantity multiplier', async ({ page }) => {
    await signInAndOpenTill(page);
    const scan = page.getByLabel('Scan or search');

    // "3*" then scan, rather than scanning the same item three times.
    await scan.fill('3*');
    await scan.press('Enter');
    await expect(scan).toHaveAttribute('placeholder', /3 x/);

    await scan.fill(COFFEE);
    await scan.press('Enter');

    // 3 x 1,200.00
    await expect(page.getByRole('button', { name: /Take payment/ })).toContainText('3,600.00');
    // The multiplier is consumed, not sticky.
    await expect(scan).toHaveAttribute('placeholder', /Scan barcode/);
  });

  test('F2 opens payment and F3 holds the basket', async ({ page }) => {
    await signInAndOpenTill(page);
    const scan = page.getByLabel('Scan or search');

    await scan.fill(COFFEE);
    await scan.press('Enter');

    await page.keyboard.press('F2');
    await expect(page.getByRole('dialog', { name: 'Payment' })).toBeVisible();
    await page.getByRole('button', { name: 'Back' }).click();

    await page.keyboard.press('F3');
    await expect(page.getByRole('dialog', { name: 'Hold this basket' })).toBeVisible();
  });

  test('offers quick keys for items with no barcode', async ({ page }) => {
    await signInAndOpenTill(page);

    // No tiles configured yet, so the till offers to set them up.
    await expect(page.getByRole('button', { name: 'Set up' })).toBeVisible();
    await page.getByRole('button', { name: 'Set up' }).click();

    const dialog = page.getByRole('dialog', { name: 'Quick keys' });
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder('Search the catalogue').fill('Avocado');

    const row = dialog.locator('label.result-item').first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.locator('input[type="checkbox"]').check();
    await dialog.getByRole('button', { name: 'Save' }).click();

    // The tile now adds the item in one tap.
    const tile = page.locator('.quick-key').filter({ hasText: 'Avocado' });
    await expect(tile).toBeVisible({ timeout: 10_000 });
    await tile.click();
    // Hass Avocado is 250.00/kg in the seed data.
    await expect(page.getByRole('button', { name: /Take payment/ })).toContainText('250.00');
  });
});
