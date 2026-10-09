import { and, eq, lt, sql, isNotNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { customers, loyaltyTransactions } from '../../db/schema/index.js';

/**
 * Expires loyalty points that have passed their expiry date.
 *
 * Points are an accounting liability: every unexpired point is a discount the
 * shop has promised. Without this, that liability only ever grows. Expiry is
 * written to the same append-only ledger as every other movement, so a customer
 * can always be shown exactly why their balance changed.
 */
export async function expireLoyaltyPoints(): Promise<{ customersAffected: number; pointsExpired: number }> {
  return db.transaction(async (tx) => {
    // Earned entries that have expired and have not already been reversed.
    const expiring = await tx
      .select({
        customerId: loyaltyTransactions.customerId,
        points: sql<number>`COALESCE(SUM(${loyaltyTransactions.points}), 0)::int`.as('points'),
      })
      .from(loyaltyTransactions)
      .where(
        and(
          isNotNull(loyaltyTransactions.expiresAt),
          lt(loyaltyTransactions.expiresAt, new Date()),
          sql`${loyaltyTransactions.points} > 0`,
          // Not already expired: an EXPIRY row referencing the same window ends it.
          sql`NOT EXISTS (
            SELECT 1 FROM loyalty_transactions expired
            WHERE expired.customer_id = ${loyaltyTransactions.customerId}
              AND expired.kind = 'EXPIRY'
              AND expired.created_at > ${loyaltyTransactions.expiresAt}
          )`,
        ),
      )
      .groupBy(loyaltyTransactions.customerId);

    let pointsExpired = 0;
    let customersAffected = 0;

    for (const row of expiring) {
      if (row.points <= 0) continue;

      const [customer] = await tx
        .select({ loyaltyPoints: customers.loyaltyPoints })
        .from(customers)
        .where(eq(customers.id, row.customerId))
        .limit(1)
        .for('update');

      if (!customer) continue;

      // Never take a balance negative: a customer may already have spent them.
      const toExpire = Math.min(customer.loyaltyPoints, row.points);
      if (toExpire <= 0) continue;

      const balanceAfter = customer.loyaltyPoints - toExpire;

      await tx.update(customers).set({ loyaltyPoints: balanceAfter }).where(eq(customers.id, row.customerId));
      await tx.insert(loyaltyTransactions).values({
        customerId: row.customerId,
        points: -toExpire,
        balanceAfter,
        kind: 'EXPIRY',
        reason: 'Points expired',
      });

      pointsExpired += toExpire;
      customersAffected++;
    }

    return { customersAffected, pointsExpired };
  });
}
