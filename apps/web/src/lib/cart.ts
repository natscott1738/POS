import { create } from 'zustand';
import { priceSale, type PricedSale, type DiscountInput, type TenderInput } from '@pos/shared';
import { db, type CachedVariant, type ParkedSale } from './db.js';

/**
 * The basket. Totals are computed with the *same* pricing function the server
 * uses, so what the cashier sees is what the server will independently confirm.
 */

export interface CartLine {
  clientLineId: string;
  variant: CachedVariant;
  /** Thousandths of a unit, so 0.25 kg is exact. */
  quantity: number;
  unitPrice: number;
  discount: DiscountInput | null;
  note: string | null;
}

interface CartState {
  lines: CartLine[];
  orderDiscount: DiscountInput | null;
  customerId: string | null;
  customerName: string | null;
  loyaltyPointsRedeemed: number;
  tenders: TenderInput[];
  note: string;
  pricesIncludeTax: boolean;
  cashRoundingIncrement: number;

  addVariant: (variant: CachedVariant, quantity?: number) => void;
  setQuantity: (clientLineId: string, quantity: number) => void;
  removeLine: (clientLineId: string) => void;
  setLineDiscount: (clientLineId: string, discount: DiscountInput | null) => void;
  setLinePrice: (clientLineId: string, unitPrice: number) => void;
  setOrderDiscount: (discount: DiscountInput | null) => void;
  setCustomer: (id: string | null, name: string | null) => void;
  setLoyaltyRedeemed: (points: number) => void;
  addTender: (tender: TenderInput) => void;
  removeTender: (index: number) => void;
  clearTenders: () => void;
  setNote: (note: string) => void;
  setStoreConfig: (pricesIncludeTax: boolean, cashRoundingIncrement: number) => void;
  clear: () => void;
  /** Sets the basket aside so the till can serve the next customer. */
  park: (label: string) => Promise<void>;
  /** Brings a parked basket back and removes it from the parked list. */
  resume: (parkedId: string) => Promise<boolean>;
  totals: () => PricedSale;
  tenderTotal: () => number;
  balance: () => number;
}

export const useCart = create<CartState>((set, get) => ({
  lines: [],
  orderDiscount: null,
  customerId: null,
  customerName: null,
  loyaltyPointsRedeemed: 0,
  tenders: [],
  note: '',
  pricesIncludeTax: true,
  cashRoundingIncrement: 0,

  addVariant(variant, quantity = 1000) {
    set((state) => {
      // Scanning the same barcode twice increments rather than adding a new line,
      // which is what a cashier expects.
      const existing = state.lines.find((l) => l.variant.variantId === variant.variantId && !l.discount);
      if (existing) {
        return {
          lines: state.lines.map((l) =>
            l.clientLineId === existing.clientLineId ? { ...l, quantity: l.quantity + quantity } : l,
          ),
        };
      }
      return {
        lines: [
          ...state.lines,
          {
            clientLineId: crypto.randomUUID(),
            variant,
            quantity,
            unitPrice: variant.unitPrice,
            discount: null,
            note: null,
          },
        ],
      };
    });
  },

  setQuantity(clientLineId, quantity) {
    if (quantity <= 0) {
      get().removeLine(clientLineId);
      return;
    }
    set((state) => ({
      lines: state.lines.map((l) => (l.clientLineId === clientLineId ? { ...l, quantity } : l)),
    }));
  },

  removeLine(clientLineId) {
    set((state) => ({ lines: state.lines.filter((l) => l.clientLineId !== clientLineId) }));
  },

  setLineDiscount(clientLineId, discount) {
    set((state) => ({
      lines: state.lines.map((l) => (l.clientLineId === clientLineId ? { ...l, discount } : l)),
    }));
  },

  setLinePrice(clientLineId, unitPrice) {
    set((state) => ({
      lines: state.lines.map((l) => (l.clientLineId === clientLineId ? { ...l, unitPrice } : l)),
    }));
  },

  setOrderDiscount: (orderDiscount) => set({ orderDiscount }),
  setCustomer: (customerId, customerName) => set({ customerId, customerName }),
  setLoyaltyRedeemed: (loyaltyPointsRedeemed) => set({ loyaltyPointsRedeemed }),
  addTender: (tender) => set((state) => ({ tenders: [...state.tenders, tender] })),
  removeTender: (index) => set((state) => ({ tenders: state.tenders.filter((_, i) => i !== index) })),
  clearTenders: () => set({ tenders: [] }),
  setNote: (note) => set({ note }),
  setStoreConfig: (pricesIncludeTax, cashRoundingIncrement) => set({ pricesIncludeTax, cashRoundingIncrement }),

  clear() {
    set({
      lines: [],
      orderDiscount: null,
      customerId: null,
      customerName: null,
      loyaltyPointsRedeemed: 0,
      tenders: [],
      note: '',
    });
  },

  async park(label) {
    const state = get();
    if (state.lines.length === 0) return;

    await db.parked.put({
      parkedId: crypto.randomUUID(),
      label,
      // The variant is snapshotted with the line so a parked basket survives a
      // catalogue refresh or a price change between parking and resuming.
      lines: state.lines.map((line) => ({
        clientLineId: line.clientLineId,
        variantId: line.variant.variantId,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discount: line.discount,
        note: line.note,
        variant: line.variant,
      })),
      orderDiscount: state.orderDiscount,
      customerId: state.customerId,
      customerName: state.customerName,
      note: state.note,
      total: state.totals().total,
      parkedAt: Date.now(),
    });

    get().clear();
  },

  async resume(parkedId) {
    const parked = await db.parked.get(parkedId);
    if (!parked) return false;

    // Anything in the basket right now would otherwise be silently discarded.
    if (get().lines.length > 0) {
      await get().park('Replaced on resume');
    }

    set({
      lines: parked.lines.map((line) => ({
        clientLineId: line.clientLineId,
        variant: line.variant,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discount: line.discount as CartLine['discount'],
        note: line.note,
      })),
      orderDiscount: parked.orderDiscount as CartState['orderDiscount'],
      customerId: parked.customerId,
      customerName: parked.customerName,
      note: parked.note,
      tenders: [],
      loyaltyPointsRedeemed: 0,
    });

    await db.parked.delete(parkedId);
    return true;
  },

  totals() {
    const state = get();
    return priceSale(
      state.lines.map((line) => ({
        clientLineId: line.clientLineId,
        variantId: line.variant.variantId,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        taxRateBasisPoints: line.variant.taxRateBasisPoints,
        taxCode: line.variant.taxCode,
        discount: line.discount,
      })),
      state.orderDiscount,
      {
        pricesIncludeTax: state.pricesIncludeTax,
        cashRoundingIncrement: state.cashRoundingIncrement,
      },
    );
  },

  tenderTotal() {
    return get().tenders.reduce((acc, t) => acc + t.amount, 0);
  },

  /** Positive means still owed by the customer; negative means over-tendered. */
  balance() {
    return get().totals().total - get().tenderTotal();
  },
}));
