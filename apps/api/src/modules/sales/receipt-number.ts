import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { terminals } from '../../db/schema/index.js';
import { notFound } from '../../core/errors.js';

/**
 * Receipt numbers are allocated per terminal by an atomic increment, so two tills
 * can never mint the same number and a gap in the sequence is evidence of a
 * deleted or failed transaction rather than a race.
 */
export async function nextReceiptNumber(tx: Tx, terminalId: string, prefix = ''): Promise<string> {
  const [row] = await tx
    .update(terminals)
    .set({ lastReceiptSequence: sql`${terminals.lastReceiptSequence} + 1` })
    .where(eq(terminals.id, terminalId))
    .returning({ seq: terminals.lastReceiptSequence, receiptPrefix: terminals.receiptPrefix });

  if (!row) throw notFound('Terminal');
  return `${prefix}${row.receiptPrefix}-${String(row.seq).padStart(6, '0')}`;
}
