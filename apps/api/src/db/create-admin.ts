import { randomBytes, randomInt } from 'node:crypto';
import { parseArgs } from 'node:util';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, closeDb } from './client.js';
import { users } from './schema/index.js';
import { hashPassword, hashPin } from '../auth/password.js';
import { writeAudit } from '../core/audit.js';

/**
 * Creates the first administrator on a fresh production database.
 *
 * The seed refuses to run in production because it mints known credentials, and
 * every other way to create a user is an authenticated API call - so without
 * this, a new deployment has no way in. It is deliberately bootstrap-only: once
 * any administrator exists it refuses, so it can never become a quiet side door
 * for minting more. Further accounts are created by an admin through the API,
 * where they are authenticated and audited against a real actor.
 *
 * The password is generated, printed once, and must be changed at first sign-in.
 *
 *   node dist/db/create-admin.js --email you@example.com [--name "Full Name"] [--staff-code ADM001]
 */

const argsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1).max(120),
  staffCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{2,16}$/, 'staff code must be 2-16 letters or digits')
    .transform((code) => code.toUpperCase())
    .optional(),
});

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string', default: 'System Administrator' },
      'staff-code': { type: 'string' },
    },
  });

  const parsed = argsSchema.safeParse({
    email: values.email,
    name: values.name,
    staffCode: values['staff-code'],
  });
  if (!parsed.success) {
    throw new Error(
      `invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    );
  }
  const input = parsed.data;

  const [existing] = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.role, 'ADMIN'), isNull(users.deletedAt)))
    .limit(1);
  if (existing) {
    throw new Error(
      `an administrator already exists (${existing.email}); sign in as them to create further accounts`,
    );
  }

  // 18 random bytes is 144 bits: far beyond guessing, and only lives until first sign-in.
  const password = randomBytes(18).toString('base64url');
  const pin = input.staffCode ? String(randomInt(0, 1_000_000)).padStart(6, '0') : null;

  const created = await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        email: input.email,
        fullName: input.name,
        role: 'ADMIN',
        passwordHash: await hashPassword(password),
        staffCode: input.staffCode ?? null,
        pinHash: pin ? await hashPin(pin) : null,
        mustChangePassword: true,
      })
      .returning({ id: users.id });

    if (!user) throw new Error('could not create the administrator');

    await writeAudit(tx, null, {
      action: 'USER_CREATED',
      entityType: 'USER',
      entityId: user.id,
      changes: { email: input.email, role: 'ADMIN', staffCode: input.staffCode ?? null },
      reason: 'Bootstrap administrator created from the command line',
    });

    return user;
  });

  /* eslint-disable no-console */
  console.log('');
  console.log('  Administrator created. These are shown once and are not stored in the clear.');
  console.log('');
  console.log(`    email               ${input.email}`);
  console.log(`    temporary password  ${password}`);
  if (input.staffCode && pin) {
    console.log(`    staff code          ${input.staffCode}`);
    console.log(`    till PIN            ${pin}`);
  }
  console.log(`    user id             ${created.id}`);
  console.log('');
  console.log('  The password must be changed at first sign-in.');
  console.log('');
  /* eslint-enable no-console */

  await closeDb();
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error(`create-admin failed: ${err instanceof Error ? err.message : String(err)}`);
  await closeDb().catch(() => {});
  process.exit(1);
});
