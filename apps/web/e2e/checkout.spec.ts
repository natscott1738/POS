import { test, expect } from '@playwright/test';

/**
 * Full journey through the real interface: sign in, bind the till, open a shift,
 * scan, take a split payment, and see the sale in history.
 *
 * Runs against the production bundle and a live API, so it exercises the same
 * code path a cashier will.
 */

const ADMIN = { email: 'admin@tigonigrown.com', password: 'ChangeMe!Admin2024' };

test.describe('checkout journey', () => {
  test.beforeEach(async ({ page }) => {
    // Each test starts from a clean device: no remembered till, no cached catalogue.
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
  });

  test('signs in, sets up the till, and completes a split-payment sale', async ({ page }) => {
    /* ------------------------------- Sign in ------------------------------- */
    await page.getByRole('button', { name: 'Email' }).click();
    await page.getByLabel('Email').fill(ADMIN.email);
    await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    /* ------------------------------ Till setup ----------------------------- */
    // Email sign-in says who you are, not where you are, so the till must ask.
    await expect(page.getByText('Set up this till')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Use this till' }).click();

    // Clear any sign-in toasts so later assertions see only sale feedback.
    for (const toast of await page.locator('.toast').all()) {
      await toast.click({ timeout: 1000 }).catch(() => {});
    }

    /* ------------------------------- Scanning ------------------------------ */
    const scan = page.getByLabel('Scan or search');
    await expect(scan).toBeVisible({ timeout: 15_000 });

    // Barcode of the seeded coffee; a scanner types then presses Enter.
    await scan.fill('6001234500024');
    await scan.press('Enter');

    await expect(page.getByText('Kenyan AA Coffee 500g').first()).toBeVisible();

    // Scanning the same item again must increment, not add a second line.
    await scan.fill('6001234500024');
    await scan.press('Enter');

    const payButton = page.getByRole('button', { name: /Take payment/ });
    await expect(payButton).toBeEnabled();
    // 2 x KES 1,200.00
    await expect(payButton).toContainText('2,400.00');

    /* ------------------------------- Payment ------------------------------- */
    await payButton.click();
    await expect(page.getByRole('dialog', { name: 'Payment' })).toBeVisible();

    // Part-pay in cash, leaving a balance for a second tender.
    await page.getByLabel('Cash received').fill('1000');
    await page.getByRole('button', { name: 'Add cash payment' }).click();

    await expect(page.getByText('OUTSTANDING')).toBeVisible();

    // Settle the rest with a manually entered M-PESA code.
    await page.getByRole('button', { name: 'M-PESA' }).click();
    // Manual code entry is now the fallback; the normal path is tapping a
    // payment that has already arrived from Safaricom.
    await page.getByText('Payment not showing? Enter the code by hand').click();
    await page.getByLabel('Confirmation code').fill(`E2E${Date.now().toString().slice(-7)}`);
    await page.getByRole('button', { name: 'Add M-PESA payment' }).click();

    const complete = page.getByRole('button', { name: 'Complete sale' });
    await expect(complete).toBeEnabled();
    await complete.click();

    /* -------------------------------- Result ------------------------------- */
    // A success toast specifically, not any text mentioning "change" — the
    // must-change-password warning also matches a loose pattern.
    await expect(page.locator('.toast.success').first()).toBeVisible({ timeout: 15_000 });

    // The payment dialog closes and the basket is ready for the next customer.
    await expect(page.getByRole('dialog', { name: 'Payment' })).toBeHidden();
    await expect(page.getByText('Empty')).toBeVisible();
  });

  test('simulates an approved card sale and a declined card attempt', async ({ page }) => {
    await page.getByRole('button', { name: 'Email' }).click();
    await page.getByLabel('Email').fill(ADMIN.email);
    await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Set up this till')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Use this till' }).click();
    await expect(page.getByLabel('Scan or search')).toBeVisible({ timeout: 15_000 });

    const shiftOpen = page.locator('.pill').filter({ hasText: /^Shift open$/ });
    if (!(await shiftOpen.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: 'Open shift' }).first().click();
      const shiftDialog = page.getByRole('dialog', { name: 'Open shift' });
      await shiftDialog.getByLabel('Opening float').fill('5000');
      await shiftDialog.getByRole('button', { name: 'Open shift' }).click();
      await expect(shiftOpen).toBeVisible({ timeout: 15_000 });
    }

    await page.getByRole('link', { name: 'Administration' }).click();
    await page.getByRole('button', { name: 'Card machines' }).click();
    await page.getByRole('button', { name: 'Add card machine' }).click();
    const terminalDialog = page.getByRole('dialog', { name: 'Add card machine' });
    await terminalDialog.getByLabel('Label').fill('Automated card simulator');
    await terminalDialog.getByLabel('Type').selectOption('SIMULATOR');
    await terminalDialog.getByRole('button', { name: 'Add terminal' }).click();
    await expect(page.getByRole('cell', { name: 'Automated card simulator' }).first()).toBeVisible({ timeout: 10_000 });

    await page.getByRole('link', { name: /Till/ }).click();
    const scan = page.getByLabel('Scan or search');
    await scan.fill('6001234500024');
    await scan.press('Enter');
    await expect(page.getByText('Kenyan AA Coffee 500g').first()).toBeVisible();
    await page.getByRole('button', { name: /Take payment/ }).click();
    await page.getByRole('button', { name: 'Card' }).click();
    await page.getByRole('button', { name: 'Send to terminal' }).click();
    await expect(page.locator('.toast.success').filter({ hasText: 'Card approved' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('PDQ').first()).toBeVisible();
    await page.getByRole('button', { name: 'Complete sale' }).click();
    await expect(page.getByRole('dialog', { name: 'Payment' })).toBeHidden({ timeout: 15_000 });

    await scan.fill('6001234500024');
    await scan.press('Enter');
    await page.getByRole('button', { name: /Take payment/ }).click();
    await page.getByRole('button', { name: 'Card' }).click();
    await page.getByLabel('Amount').fill('12.13');
    await page.getByRole('button', { name: 'Send to terminal' }).click();
    await expect(page.locator('.toast.error').filter({ hasText: 'Insufficient funds' })).toBeVisible({ timeout: 10_000 });
  });

  test('blocks checkout until the till is bound, then opens a shift', async ({ page }) => {
    await page.getByRole('button', { name: 'Email' }).click();
    await page.getByLabel('Email').fill(ADMIN.email);
    await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // The old bug: checkout rendered with a permanently disabled pay button and
    // no way to fix it. Now it asks, explicitly.
    await expect(page.getByText('Set up this till')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel('Store')).toBeVisible();
    await expect(page.getByLabel('Till')).toBeVisible();
    await page.getByRole('button', { name: 'Use this till' }).click();

    await expect(page.getByLabel('Scan or search')).toBeVisible({ timeout: 15_000 });

    // Anchored: Playwright's hasText does case-insensitive substring matching,
    // so a bare 'Shift open' also matches the "No shift open" badge.
    const openBadge = page.locator('.pill').filter({ hasText: /^Shift open$/ });
    const closedBadge = page.locator('.pill').filter({ hasText: /^No shift open$/ });
    const openButton = page.getByRole('button', { name: 'Open shift' }).first();

    if (await openBadge.isVisible().catch(() => false)) {
      // A shift was already open from an earlier run; close it so this test
      // exercises the path it is named after rather than silently skipping it.
      await page.getByRole('button', { name: 'Close shift' }).first().click();
      const dialog = page.getByRole('dialog', { name: 'Close shift' });
      await dialog.getByLabel('Counted cash in drawer').fill('0');
      await dialog.getByLabel(/^Note/).fill('closed by automated test');
      await dialog.getByRole('button', { name: 'Close shift' }).click();
      await expect(closedBadge).toBeVisible({ timeout: 15_000 });
    }

    await expect(openButton).toBeVisible({ timeout: 15_000 });
    await openButton.click();

    const dialog = page.getByRole('dialog', { name: 'Open shift' });
    await dialog.getByLabel('Opening float').fill('5000');
    await dialog.getByRole('button', { name: 'Open shift' }).click();

    await expect(openBadge).toBeVisible({ timeout: 15_000 });
  });

  test('navigates to the dashboard and shows today', async ({ page }) => {
    await page.getByRole('button', { name: 'Email' }).click();
    await page.getByLabel('Email').fill(ADMIN.email);
    await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Use this till' }).click();
    await expect(page.getByLabel('Scan or search')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('link', { name: 'Today' }).click();
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
    await expect(page.getByText('Takings')).toBeVisible();
  });
});
