import { useEffect, useState } from 'react';
import { formatCents, changeDue, type CreateSaleInput, type TenderInput } from '@pos/shared';
import { useCart } from '../lib/cart.js';
import { api, ApiError } from '../lib/api.js';
import { enqueue, db, getMeta } from '../lib/db.js';
import { useAuth, useNetwork, toast } from '../lib/store.js';
import { runSync } from '../lib/sync.js';
import { printReceipt, loadPrinterConfig } from '../lib/printer.js';
import type { ReceiptData } from '@pos/shared';
import { Modal } from '../components/Modal.js';
import { Field } from '../components/ui.js';

type Method = 'CASH' | 'MPESA' | 'PDQ';

export function PaymentPanel({
  storeId,
  terminalId,
  onClose,
  onComplete,
}: {
  storeId: string;
  terminalId: string;
  onClose: () => void;
  onComplete: () => void;
}) {
  const cart = useCart();
  const online = useNetwork((s) => s.serverReachable);
  const shiftId = useAuth((s) => s.shiftId);
  const [method, setMethod] = useState<Method>('CASH');
  const [submitting, setSubmitting] = useState(false);

  const totals = cart.totals();
  const outstanding = cart.balance();
  const settled = outstanding <= 0;

  /** Change is only ever produced by over-tendered cash. */
  function changeFromCash(): number {
    return cart.tenders.reduce(
      (acc, t) => acc + (t.method === 'CASH' ? Math.max(0, t.tendered - t.amount) : 0),
      0,
    );
  }

  async function completeSale(): Promise<void> {
    if (!settled) {
      toast.error('The basket is not fully paid');
      return;
    }
    setSubmitting(true);

    const clientSaleId = crypto.randomUUID();
    const soldAt = new Date().toISOString();

    const payload: CreateSaleInput = {
      clientSaleId,
      storeId,
      terminalId,
      shiftId,
      customerId: cart.customerId,
      lines: cart.lines.map((line) => ({
        clientLineId: line.clientLineId,
        variantId: line.variant.variantId,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discount: line.discount,
        note: line.note,
      })),
      orderDiscount: cart.orderDiscount,
      tenders: cart.tenders,
      declaredTotal: totals.total,
      soldAt,
      note: cart.note || null,
      receiptEmail: null,
      receiptPhone: null,
      loyaltyPointsRedeemed: cart.loyaltyPointsRedeemed,
    };

    // Always record locally first. If the network call then fails, the sale is
    // already safe and the queue will deliver it.
    await db.sales.put({
      clientSaleId,
      receiptNumber: null,
      total: totals.total,
      status: 'QUEUED',
      soldAt,
      payload,
    });

    if (!online) {
      await enqueue({ opId: crypto.randomUUID(), type: 'SALE_CREATE', occurredAt: soldAt, payload });
      toast.success(`Sale saved offline · ${formatCents(totals.total)}`);
      // Offline sales have no server receipt number yet; print with the local id.
      await printSaleReceipt(`OFFLINE-${clientSaleId.slice(0, 8).toUpperCase()}`, changeFromCash());
      finish();
      return;
    }

    try {
      const result = await api.post<{ receiptNumber: string; changeGiven: number; oversold: boolean }>(
        '/sales',
        payload,
        clientSaleId,
      );
      await db.sales.put({
        clientSaleId,
        receiptNumber: result.receiptNumber,
        total: totals.total,
        status: 'SYNCED',
        soldAt,
        payload,
      });
      if (result.changeGiven > 0) {
        toast.success(`${result.receiptNumber} · change ${formatCents(result.changeGiven)}`);
      } else {
        toast.success(`Sale complete · ${result.receiptNumber}`);
      }
      if (result.oversold) toast.warning('This sale took stock below zero. Check inventory.');
      await printSaleReceipt(result.receiptNumber, result.changeGiven);
      finish();
    } catch (err) {
      // A network failure is recoverable: queue it. A rejection is not: the
      // cashier must see why, because the totals or stock were refused.
      if (err instanceof ApiError && err.code === 'NETWORK') {
        await enqueue({ opId: crypto.randomUUID(), type: 'SALE_CREATE', occurredAt: soldAt, payload });
        toast.warning('Server unreachable — the sale is queued and will sync.');
        finish();
      } else {
        await db.sales.delete(clientSaleId);
        toast.error(err instanceof ApiError ? err.message : 'The sale was refused');
        setSubmitting(false);
      }
    }
  }

  /**
   * Prints after the sale is safely recorded, never before. A printer fault must
   * warn rather than roll back money that has already changed hands.
   */
  async function printSaleReceipt(receiptNumber: string, changeGiven: number): Promise<void> {
    const config = await loadPrinterConfig();
    if (config.transport === 'NONE') return;

    const hasCash = cart.tenders.some((t) => t.method === 'CASH');
    const receipt: ReceiptData = {
      receiptNumber,
      soldAt: new Date(),
      cashierName: null,
      customerName: cart.customerName,
      lines: totals.lines.map((line) => {
        const source = cart.lines.find((l) => l.clientLineId === line.clientLineId);
        return {
          productName: source?.variant.name ?? 'Item',
          variantLabel: source?.variant.variantLabel ?? null,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
          lineDiscount: line.lineDiscount + line.allocatedOrderDiscount,
        };
      }),
      subtotal: totals.grossSubtotal,
      discountTotal: totals.discountTotal,
      taxTotal: totals.taxTotal,
      roundingAdjustment: totals.roundingAdjustment,
      total: totals.total,
      changeGiven,
      payments: cart.tenders.map((t) => ({
        method: t.method,
        amount: t.amount,
        externalReference: t.method === 'MPESA' ? (t.confirmationCode ?? null) : t.method === 'PDQ' ? (t.authCode ?? null) : null,
        maskedPan: t.method === 'PDQ' ? (t.maskedPan ?? null) : null,
      })),
      taxBreakdown: totals.taxBreakdown,
      store: await getMeta('storeProfile', { name: 'Receipt' }),
    };

    const result = await printReceipt(receipt, {
      openDrawer: hasCash && config.openDrawerOnCashSale,
    });
    if (!result.printed && result.error) toast.warning(`Receipt not printed: ${result.error}`);
  }

  function finish(): void {
    cart.clear();
    setSubmitting(false);
    void runSync();
    onComplete();
  }

  return (
    <Modal title="Payment" onClose={onClose} wide>
      <div className="row" style={{ marginBottom: 14 }}>
        <div>
          <div className="muted" style={{ fontSize: 12 }}>TOTAL</div>
          <div style={{ fontSize: 26, fontWeight: 700 }}>{formatCents(totals.total)}</div>
        </div>
        <div className="spacer" />
        <div className="right">
          <div className="muted" style={{ fontSize: 12 }}>{outstanding > 0 ? 'OUTSTANDING' : 'CHANGE'}</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: outstanding > 0 ? 'var(--warning)' : 'var(--success)' }}>
            {formatCents(Math.abs(outstanding))}
          </div>
        </div>
      </div>

      {cart.tenders.length > 0 && (
        <div className="card" style={{ marginBottom: 14, padding: 10 }}>
          {cart.tenders.map((tender, index) => (
            <div key={index} className="row" style={{ padding: '5px 0' }}>
              <strong>{tender.method}</strong>
              {tender.method === 'MPESA' && <span className="muted mono">{tender.phone}</span>}
              {tender.method === 'PDQ' && tender.authCode && <span className="muted mono">{tender.authCode}</span>}
              <div className="spacer" />
              <span className="mono">{formatCents(tender.amount)}</span>
              <button className="btn ghost" style={{ minHeight: 28, padding: '2px 8px' }} onClick={() => cart.removeTender(index)}>✕</button>
            </div>
          ))}
        </div>
      )}

      {outstanding > 0 && (
        <>
          <div className="tabs">
            <button className={method === 'CASH' ? 'active' : ''} onClick={() => setMethod('CASH')}>Cash</button>
            <button className={method === 'MPESA' ? 'active' : ''} onClick={() => setMethod('MPESA')}>M-PESA</button>
            <button className={method === 'PDQ' ? 'active' : ''} onClick={() => setMethod('PDQ')}>Card</button>
          </div>

          {method === 'CASH' && <CashTender outstanding={outstanding} />}
          {method === 'MPESA' && <MpesaTender outstanding={outstanding} storeId={storeId} terminalId={terminalId} />}
          {method === 'PDQ' && <CardTender outstanding={outstanding} storeId={storeId} terminalId={terminalId} />}
        </>
      )}

      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn ghost" onClick={onClose}>Back</button>
        <div className="spacer" />
        <button className="btn success lg" disabled={!settled || submitting} onClick={() => void completeSale()}>
          {submitting ? 'Completing…' : 'Complete sale'}
        </button>
      </div>
    </Modal>
  );
}

function CashTender({ outstanding }: { outstanding: number }) {
  const cart = useCart();
  const [amount, setAmount] = useState('');

  const tendered = Math.round(Number(amount || 0) * 100);
  const change = tendered > 0 ? changeDue(outstanding, tendered) : 0;

  // Notes a Kenyan till actually holds.
  const quickAmounts = [50, 100, 200, 500, 1000].map((n) => n * 100);

  function apply(cashGiven: number): void {
    if (cashGiven < outstanding) {
      // A part payment in cash settles only what it covers; the rest stays owed.
      cart.addTender({ method: 'CASH', amount: cashGiven, tendered: cashGiven });
    } else {
      cart.addTender({ method: 'CASH', amount: outstanding, tendered: cashGiven });
    }
    setAmount('');
  }

  return (
    <>
      <Field label="Cash received">
        <input
          className="input mono"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
          inputMode="decimal"
          placeholder={(outstanding / 100).toFixed(2)}
          autoFocus
          style={{ fontSize: 20 }}
        />
      </Field>
      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        <button className="btn" onClick={() => apply(outstanding)}>Exact {formatCents(outstanding)}</button>
        {quickAmounts.filter((a) => a >= outstanding).slice(0, 3).map((a) => (
          <button key={a} className="btn" onClick={() => apply(a)}>{formatCents(a)}</button>
        ))}
      </div>
      {tendered > 0 && (
        <p className="muted">
          Change: <strong className="mono">{formatCents(Math.max(0, change))}</strong>
        </p>
      )}
      <button className="btn primary block" disabled={tendered <= 0} onClick={() => apply(tendered)}>
        Add cash payment
      </button>
    </>
  );
}

function MpesaTender({
  outstanding,
  storeId,
  terminalId,
}: {
  outstanding: number;
  storeId: string;
  terminalId: string;
}) {
  const cart = useCart();
  const [phone, setPhone] = useState('');
  const [amount, setAmount] = useState((outstanding / 100).toFixed(2));
  const [transactionId, setTransactionId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  /**
   * Poll while the customer responds to the prompt on their handset. Stops on a
   * terminal state so the till never spins forever.
   */
  useEffect(() => {
    if (!transactionId) return;
    let stop = false;

    const tick = async (): Promise<void> => {
      try {
        const result = await api.get<{
          status: string;
          confirmationCode: string | null;
          confirmedAmount: number | null;
          amountMismatch: boolean;
          resultDescription: string | null;
        }>(`/payments/mpesa/${transactionId}`);

        if (stop) return;
        setStatus(result.status);

        if (result.status === 'CAPTURED' && result.confirmationCode) {
          if (result.amountMismatch) {
            toast.warning(
              `Customer paid ${formatCents(result.confirmedAmount ?? 0)}, not ${formatCents(Math.round(Number(amount) * 100))}.`,
            );
          }
          cart.addTender({
            method: 'MPESA',
            amount: result.confirmedAmount ?? Math.round(Number(amount) * 100),
            phone,
            confirmationCode: result.confirmationCode,
            mpesaTransactionId: transactionId,
          });
          toast.success(`M-PESA received · ${result.confirmationCode}`);
          setTransactionId(null);
          return;
        }

        if (['FAILED', 'CANCELLED', 'EXPIRED'].includes(result.status)) {
          toast.error(result.resultDescription ?? `M-PESA ${result.status.toLowerCase()}`);
          setTransactionId(null);
        }
      } catch {
        // Transient: keep polling, the interval will retry.
      }
    };

    const interval = setInterval(() => void tick(), 3000);
    void tick();
    return () => {
      stop = true;
      clearInterval(interval);
    };
  }, [transactionId, amount, phone, cart]);

  async function push(): Promise<void> {
    const cents = Math.round(Number(amount) * 100);
    if (cents <= 0) return;
    if (cents % 100 !== 0) {
      toast.error('M-PESA only accepts whole shillings');
      return;
    }
    setBusy(true);
    try {
      const result = await api.post<{ transactionId: string; customerMessage: string }>('/payments/mpesa/stk-push', {
        storeId,
        terminalId,
        phone,
        amount: cents,
        reference: 'POS',
        description: 'Purchase',
      });
      setTransactionId(result.transactionId);
      setStatus('PENDING');
      toast.info(result.customerMessage || 'Prompt sent to the customer.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send the prompt');
    } finally {
      setBusy(false);
    }
  }

  /** Manual capture for when the customer paid by paybill before being asked. */
  function addManual(): void {
    const cents = Math.round(Number(amount) * 100);
    if (!/^[A-Z0-9]{8,15}$/.test(code.toUpperCase())) {
      toast.error('Enter the M-PESA confirmation code');
      return;
    }
    cart.addTender({
      method: 'MPESA',
      amount: cents,
      phone: phone || '254700000000',
      confirmationCode: code.toUpperCase(),
    });
    setCode('');
  }

  return (
    <>
      <Field label="Customer phone">
        <input
          className="input mono"
          value={phone}
          onChange={(e) => setPhone(e.target.value.replace(/[^\d+]/g, ''))}
          placeholder="07XX XXX XXX"
          inputMode="tel"
        />
      </Field>
      <Field label="Amount">
        <input className="input mono" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" />
      </Field>

      {transactionId ? (
        <div className="banner warning">
          Waiting for the customer to enter their PIN… <strong>{status}</strong>
          <button className="btn ghost block" style={{ marginTop: 8 }} onClick={() => setTransactionId(null)}>
            Stop waiting
          </button>
        </div>
      ) : (
        <button className="btn primary block" disabled={busy || phone.length < 9} onClick={() => void push()}>
          {busy ? 'Sending…' : 'Send payment request'}
        </button>
      )}

      <details style={{ marginTop: 14 }}>
        <summary className="muted" style={{ cursor: 'pointer' }}>Customer already paid — enter code</summary>
        <Field label="Confirmation code">
          <input
            className="input mono"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            placeholder="SFE4G8H2K1"
          />
        </Field>
        <button className="btn block" onClick={addManual}>Add M-PESA payment</button>
      </details>
    </>
  );
}

function CardTender({
  outstanding,
  storeId,
  terminalId,
}: {
  outstanding: number;
  storeId: string;
  terminalId: string;
}) {
  const cart = useCart();
  const [pdqTerminals, setPdqTerminals] = useState<Array<{ id: string; label: string }>>([]);
  const [pdqTerminalId, setPdqTerminalId] = useState('');
  const [amount, setAmount] = useState((outstanding / 100).toFixed(2));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .get<{ terminals: Array<{ id: string; label: string }> }>(`/admin/pdq-terminals?storeId=${storeId}`)
      .then((r) => {
        setPdqTerminals(r.terminals);
        if (r.terminals[0]) setPdqTerminalId(r.terminals[0].id);
      })
      .catch(() => setPdqTerminals([]));
  }, [storeId]);

  async function charge(): Promise<void> {
    const cents = Math.round(Number(amount) * 100);
    if (cents <= 0 || !pdqTerminalId) return;
    setBusy(true);
    try {
      const result = await api.post<{
        transactionId: string;
        approved: boolean;
        pending: boolean;
        authCode?: string;
        maskedPan?: string;
        cardScheme?: string;
        message?: string;
      }>('/payments/pdq/sale', {
        storeId,
        terminalId,
        pdqTerminalId,
        amount: cents,
        reference: 'POS',
      });

      if (result.approved) {
        cart.addTender({
          method: 'PDQ',
          amount: cents,
          pdqTransactionId: result.transactionId,
          ...(result.authCode ? { authCode: result.authCode } : {}),
          ...(result.maskedPan ? { maskedPan: result.maskedPan } : {}),
          ...(result.cardScheme ? { cardScheme: result.cardScheme as never } : {}),
        });
        toast.success(`Card approved${result.authCode ? ` · ${result.authCode}` : ''}`);
      } else if (result.pending) {
        // Ambiguous outcome: never assume it failed, or the customer may be charged twice.
        toast.warning('The terminal has not answered. Check the card machine before retrying.');
      } else {
        toast.error(result.message ?? 'Card declined');
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Card payment failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Field label="Card terminal">
        <select className="input" value={pdqTerminalId} onChange={(e) => setPdqTerminalId(e.target.value)}>
          {pdqTerminals.length === 0 && <option value="">No terminal configured</option>}
          {pdqTerminals.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
      </Field>
      <Field label="Amount">
        <input className="input mono" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" />
      </Field>
      <button className="btn primary block" disabled={busy || !pdqTerminalId} onClick={() => void charge()}>
        {busy ? 'Waiting for the card machine…' : 'Send to terminal'}
      </button>
    </>
  );
}
