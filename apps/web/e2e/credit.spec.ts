import { test, expect } from '@playwright/test';

const ADMIN = { email: 'admin@tigonigrown.com', password: 'ChangeMe!Admin2024' };

test('lists a customer credit account and opens its ledger', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Email' }).click();
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Set up this till')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Use this till' }).click();
  await expect(page.getByLabel('Scan or search')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('link', { name: 'Credit accounts' }).click();
  await expect(page.getByRole('heading', { name: 'Credit accounts' })).toBeVisible();

  const account = page.getByRole('row').filter({ hasText: 'Acme Trading Ltd' });
  await expect(account).toBeVisible();
  await expect(account).toContainText('5,000.00');
  await account.getByRole('button', { name: 'Open' }).click();

  const ledger = page.getByRole('dialog', { name: 'Acme Trading Ltd' });
  await expect(ledger).toBeVisible();
  await expect(ledger.getByRole('heading', { name: 'Account activity' })).toBeVisible();
  await expect(ledger.getByText('Available credit')).toBeVisible();
});
