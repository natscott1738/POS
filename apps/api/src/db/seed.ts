import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, closeDb } from './client.js';
import {
  stores,
  terminals,
  pdqTerminals,
  users,
  userStores,
  categories,
  products,
  productVariants,
  priceHistory,
  stockLevels,
  customers,
  creditAccounts,
  syncDevices,
} from './schema/index.js';
import { hashPassword, hashPin } from '../auth/password.js';
import { applyStockMovement } from '../modules/inventory/service.js';
import { env } from '../config/env.js';

/**
 * Development seed. Refuses to run in production: it creates known credentials,
 * which would be a critical vulnerability on a live till.
 */
async function main(): Promise<void> {
  if (env.NODE_ENV === 'production') {
    throw new Error('refusing to seed a production database');
  }

  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe!Admin2024';

  const [store] = await db
    .insert(stores)
    .values({
      code: 'MAIN',
      name: 'Tigoni Grown - Main Store',
      address: 'Limuru Road, Tigoni, Kiambu',
      phone: '254700000000',
      taxPin: 'P051234567X',
      currency: 'KES',
      pricesIncludeTax: true,
      receiptHeader: 'TIGONI GROWN LIMITED',
      receiptFooter: 'Thank you for shopping with us.',
    })
    .onConflictDoNothing()
    .returning();

  const storeId =
    store?.id ?? (await db.select().from(stores).where(eq(stores.code, 'MAIN')).limit(1))[0]!.id;

  const [terminal] = await db
    .insert(terminals)
    .values({ storeId, code: 'T1', name: 'Front counter', receiptPrefix: 'MAINT1' })
    .onConflictDoNothing()
    .returning();

  const terminalId =
    terminal?.id ?? (await db.select().from(terminals).where(eq(terminals.storeId, storeId)).limit(1))[0]!.id;

  await db
    .insert(pdqTerminals)
    .values({ storeId, terminalId, label: 'Counter card machine', provider: 'SIMULATOR', acquirer: 'DEV' })
    .onConflictDoNothing();

  const deviceId = randomUUID();
  await db
    .insert(syncDevices)
    .values({ deviceId, storeId, terminalId, label: 'Seeded till' })
    .onConflictDoNothing();

  /* ---------------------------------- Users --------------------------------- */

  const staff = [
    { email: 'admin@tigonigrown.com', fullName: 'System Administrator', role: 'ADMIN' as const, staffCode: 'ADM001', pin: '1379' },
    { email: 'manager@tigonigrown.com', fullName: 'Store Manager', role: 'MANAGER' as const, staffCode: 'MGR001', pin: '2468' },
    { email: 'cashier@tigonigrown.com', fullName: 'Counter Cashier', role: 'CASHIER' as const, staffCode: 'CSH001', pin: '1357' },
    { email: 'auditor@tigonigrown.com', fullName: 'External Auditor', role: 'AUDITOR' as const, staffCode: 'AUD001', pin: '9753' },
  ];

  for (const person of staff) {
    const [user] = await db
      .insert(users)
      .values({
        email: person.email,
        fullName: person.fullName,
        role: person.role,
        isOwner: person.role === 'ADMIN',
        passwordHash: await hashPassword(adminPassword),
        staffCode: person.staffCode,
        pinHash: await hashPin(person.pin),
        mustChangePassword: true,
      })
      .onConflictDoNothing()
      .returning({ id: users.id });

    const userId =
      user?.id ?? (await db.select().from(users).where(eq(users.email, person.email)).limit(1))[0]?.id;
    if (userId) {
      await db.insert(userStores).values({ userId, storeId }).onConflictDoNothing();
    }
  }

  /* -------------------------------- Catalogue ------------------------------- */

  const [produce] = await db.insert(categories).values({ name: 'Fresh Produce' }).onConflictDoNothing().returning();
  const [beverages] = await db.insert(categories).values({ name: 'Beverages' }).onConflictDoNothing().returning();
  const [apparel] = await db.insert(categories).values({ name: 'Apparel' }).onConflictDoNothing().returning();

  const catalogue = [
    {
      name: 'Hass Avocado',
      categoryId: produce?.id ?? null,
      taxCode: 'ZERO_RATED' as const,
      taxRate: 0,
      uom: 'KG' as const,
      axes: [],
      variants: [{ sku: 'AVO-HASS', barcode: '6001234500017', attributes: {}, price: 25_000, cost: 15_000, reorder: 20_000 }],
    },
    {
      name: 'Kenyan AA Coffee 500g',
      categoryId: beverages?.id ?? null,
      taxCode: 'STANDARD' as const,
      taxRate: 1600,
      uom: 'EACH' as const,
      axes: [],
      variants: [{ sku: 'COF-AA-500', barcode: '6001234500024', attributes: {}, price: 120_000, cost: 78_000, reorder: 10_000 }],
    },
    {
      name: 'Cotton T-Shirt',
      categoryId: apparel?.id ?? null,
      taxCode: 'STANDARD' as const,
      taxRate: 1600,
      uom: 'EACH' as const,
      axes: [
        { name: 'Size', values: ['S', 'M', 'L', 'XL'] },
        { name: 'Colour', values: ['Navy', 'White'] },
      ],
      variants: [
        { sku: 'TSH-NVY-S', barcode: '6001234500031', attributes: { Size: 'S', Colour: 'Navy' }, price: 85_000, cost: 42_000, reorder: 5_000 },
        { sku: 'TSH-NVY-M', barcode: '6001234500048', attributes: { Size: 'M', Colour: 'Navy' }, price: 85_000, cost: 42_000, reorder: 5_000 },
        { sku: 'TSH-NVY-L', barcode: '6001234500055', attributes: { Size: 'L', Colour: 'Navy' }, price: 85_000, cost: 42_000, reorder: 5_000 },
        { sku: 'TSH-WHT-M', barcode: '6001234500062', attributes: { Size: 'M', Colour: 'White' }, price: 85_000, cost: 42_000, reorder: 5_000 },
      ],
    },
    {
      name: 'Bottled Water 1L',
      categoryId: beverages?.id ?? null,
      taxCode: 'STANDARD' as const,
      taxRate: 1600,
      uom: 'EACH' as const,
      axes: [],
      variants: [{ sku: 'WTR-1L', barcode: '6001234500079', attributes: {}, price: 8_000, cost: 4_500, reorder: 48_000 }],
    },
  ];

  const [seedUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, 'admin@tigonigrown.com')).limit(1);

  for (const item of catalogue) {
    const [product] = await db
      .insert(products)
      .values({
        name: item.name,
        categoryId: item.categoryId,
        taxRateBasisPoints: item.taxRate,
        taxCode: item.taxCode,
        unitOfMeasure: item.uom,
        axes: item.axes,
      })
      .returning({ id: products.id });

    if (!product) continue;

    for (const variant of item.variants) {
      const [row] = await db
        .insert(productVariants)
        .values({
          productId: product.id,
          sku: variant.sku,
          barcode: variant.barcode,
          attributes: variant.attributes,
          unitPrice: variant.price,
          costPrice: variant.cost,
          reorderPoint: variant.reorder,
          reorderQuantity: variant.reorder * 2,
        })
        .onConflictDoNothing()
        .returning({ id: productVariants.id });

      if (!row) continue;

      await db.insert(priceHistory).values({
        variantId: row.id,
        unitPrice: variant.price,
        costPrice: variant.cost,
        changedBy: seedUser?.id ?? null,
        reason: 'Seed data',
      });

      await db
        .insert(stockLevels)
        .values({ storeId, variantId: row.id, quantityOnHand: 0, averageCost: variant.cost })
        .onConflictDoNothing();

      // Opening balances go through the ledger so the movement history is complete.
      await db.transaction((tx) =>
        applyStockMovement(tx, {
          storeId,
          variantId: row.id,
          quantityDelta: 100_000,
          reason: 'OPENING_BALANCE',
          unitCost: variant.cost,
          note: 'Seed opening stock',
          performedBy: seedUser?.id ?? null,
          allowNegative: true,
        }),
      );
    }
  }

  await db
    .insert(customers)
    .values([
      { fullName: 'Walk-in Customer', phone: null, marketingConsent: false },
      { fullName: 'Jane Wanjiru', phone: '254712345678', email: 'jane@example.com', marketingConsent: true, marketingConsentAt: new Date(), loyaltyPoints: 250 },
      { fullName: 'Acme Trading Ltd', phone: '254733111222', taxPin: 'P051111111A', creditLimit: 500_000, marketingConsent: false },
    ])
    .onConflictDoNothing();

  const [acme] = await db.select({ id: customers.id }).from(customers).where(eq(customers.phone, '254733111222')).limit(1);
  if (acme) {
    await db.insert(creditAccounts).values({
      customerId: acme.id,
      storeId,
      creditLimit: 500_000,
      termsDays: 30,
    }).onConflictDoNothing();
  }

  /* eslint-disable no-console */
  console.log('\nSeed complete.\n');
  console.log(`  Store        ${storeId}`);
  console.log(`  Terminal     ${terminalId}`);
  console.log(`  Sync device  ${deviceId}\n`);
  console.log('  Sign-in (all accounts share this password, change on first use):');
  console.log(`    password   ${adminPassword}`);
  for (const person of staff) {
    console.log(`    ${person.role.padEnd(8)} ${person.email.padEnd(30)} staff ${person.staffCode} pin ${person.pin}`);
  }
  console.log('');
  /* eslint-enable no-console */

  await closeDb();
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error('seed failed', err);
  await closeDb().catch(() => {});
  process.exit(1);
});
