import { useState } from 'react';
import { formatCents } from '@pos/shared';
import { api } from '../lib/api.js';
import { useApi, useMutation } from '../lib/useApi.js';
import { useAuth } from '../lib/store.js';
import { Modal } from '../components/Modal.js';
import { Page, Field, FormGrid, Empty, Loading, MoneyInput, QuantityInput, Badge } from '../components/ui.js';
import { formatQuantity } from '../components/Money.js';
import ImportProducts from './ImportProducts.js';

interface Variant {
  id: string;
  sku: string;
  barcode: string | null;
  attributes: Record<string, string>;
  unitPrice: number;
  costPrice: number;
  reorderPoint: number;
  reorderQuantity: number;
  isActive: boolean;
}

interface Product {
  id: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  taxRateBasisPoints: number;
  taxCode: 'STANDARD' | 'ZERO_RATED' | 'EXEMPT';
  unitOfMeasure: string;
  trackInventory: boolean;
  isActive: boolean;
  variants: Variant[];
}

export default function Products() {
  const can = useAuth((s) => s.can);
  const { data, loading, reload } = useApi<{ products: Product[] }>('/catalog/products?limit=200&includeInactive=true');
  const { data: categories } = useApi<{ categories: Array<{ id: string; name: string }> }>('/catalog/categories');
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [pricing, setPricing] = useState<Variant | null>(null);
  const [importing, setImporting] = useState(false);
  const [search, setSearch] = useState('');

  const products = (data?.products ?? []).filter((p) =>
    search ? p.name.toLowerCase().includes(search.toLowerCase()) ||
             p.variants.some((v) => v.sku.toLowerCase().includes(search.toLowerCase())) : true,
  );

  return (
    <Page
      title="Products"
      subtitle="Catalogue, variants and prices"
      actions={
        can('product:write') && (
          <div className="row">
            <button className="btn ghost" onClick={() => setImporting(true)}>Import CSV</button>
            <button className="btn primary" onClick={() => setEditing('new')}>New product</button>
          </div>
        )
      }
    >
      <div className="row" style={{ marginBottom: 14 }}>
        <input
          className="input"
          style={{ maxWidth: 340 }}
          placeholder="Search by name or SKU"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {loading ? (
        <Loading />
      ) : products.length === 0 ? (
        <div className="card">
          <Empty
            message={search ? 'No products match that search.' : 'No products yet.'}
            action={
              can('product:write') && !search ? (
                <button className="btn primary" onClick={() => setEditing('new')}>Add your first product</button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="grid" style={{ gap: 12 }}>
          {products.map((product) => (
            <div key={product.id} className="card">
              <div className="row">
                <div>
                  <strong>{product.name}</strong>
                  {!product.isActive && <span style={{ marginLeft: 8 }}><Badge tone="danger">inactive</Badge></span>}
                  <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
                    {product.taxCode === 'STANDARD' ? `VAT ${product.taxRateBasisPoints / 100}%` : product.taxCode.replace('_', ' ').toLowerCase()}
                    {' · '}per {product.unitOfMeasure.toLowerCase()}
                    {!product.trackInventory && ' · stock not tracked'}
                  </div>
                </div>
                <div className="spacer" />
                {can('product:write') && (
                  <button className="btn ghost" onClick={() => setEditing(product)}>Edit</button>
                )}
              </div>

              <table style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Variant</th>
                    <th>Barcode</th>
                    <th className="num">Price</th>
                    <th className="num">Cost</th>
                    <th className="num">Reorder at</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {product.variants.map((variant) => (
                    <tr key={variant.id}>
                      <td className="mono">{variant.sku}</td>
                      <td>{Object.entries(variant.attributes).map(([k, v]) => `${k}: ${v}`).join(' / ') || '—'}</td>
                      <td className="mono muted">{variant.barcode ?? '—'}</td>
                      <td className="num">{formatCents(variant.unitPrice)}</td>
                      <td className="num muted">{formatCents(variant.costPrice)}</td>
                      <td className="num muted">{formatQuantity(variant.reorderPoint)}</td>
                      <td className="right">
                        {can('product:write') && (
                          <button
                            className="btn ghost"
                            style={{ minHeight: 28, padding: '2px 8px', fontSize: 12 }}
                            onClick={() => setPricing(variant)}
                          >
                            Change price
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <ProductForm
          product={editing === 'new' ? null : editing}
          categories={categories?.categories ?? []}
          onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); void reload(); }}
        />
      )}
      {importing && <ImportProducts onClose={() => setImporting(false)} onDone={() => void reload()} />}
      {pricing && (
        <PriceChange
          variant={pricing}
          onClose={() => setPricing(null)}
          onDone={() => { setPricing(null); void reload(); }}
        />
      )}
    </Page>
  );
}

interface DraftVariant {
  sku: string;
  barcode: string;
  attributes: Record<string, string>;
  unitPrice: number;
  costPrice: number;
  reorderPoint: number;
  reorderQuantity: number;
  isActive: boolean;
}

function blankVariant(): DraftVariant {
  return { sku: '', barcode: '', attributes: {}, unitPrice: 0, costPrice: 0, reorderPoint: 0, reorderQuantity: 0, isActive: true };
}

function ProductForm({
  product,
  categories,
  onClose,
  onDone,
}: {
  product: Product | null;
  categories: Array<{ id: string; name: string }>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(product?.name ?? '');
  const [categoryId, setCategoryId] = useState(product?.categoryId ?? '');
  const [taxCode, setTaxCode] = useState<Product['taxCode']>(product?.taxCode ?? 'STANDARD');
  const [unitOfMeasure, setUom] = useState(product?.unitOfMeasure ?? 'EACH');
  const [trackInventory, setTrack] = useState(product?.trackInventory ?? true);
  const [isActive, setActive] = useState(product?.isActive ?? true);
  const [variants, setVariants] = useState<DraftVariant[]>(
    product?.variants.map((v) => ({
      sku: v.sku,
      barcode: v.barcode ?? '',
      attributes: v.attributes,
      unitPrice: v.unitPrice,
      costPrice: v.costPrice,
      reorderPoint: v.reorderPoint,
      reorderQuantity: v.reorderQuantity,
      isActive: v.isActive,
    })) ?? [blankVariant()],
  );
  const { busy, run } = useMutation();

  const editing = product !== null;

  function save(): void {
    const body = {
      name,
      categoryId: categoryId || null,
      taxCode,
      // Zero-rated and exempt goods must carry a zero rate, not a hidden 16%.
      taxRateBasisPoints: taxCode === 'STANDARD' ? 1600 : 0,
      unitOfMeasure,
      trackInventory,
      isActive,
      axes: [],
      variants: variants.map((v) => ({
        sku: v.sku.trim(),
        barcode: v.barcode.trim() || null,
        attributes: v.attributes,
        unitPrice: v.unitPrice,
        costPrice: v.costPrice,
        reorderPoint: v.reorderPoint,
        reorderQuantity: v.reorderQuantity,
        isActive: v.isActive,
      })),
    };

    void run(
      () =>
        editing
          ? // Variants are edited individually; PATCH only touches product fields.
            api.patch(`/catalog/products/${product.id}`, {
              name: body.name,
              categoryId: body.categoryId,
              taxCode: body.taxCode,
              taxRateBasisPoints: body.taxRateBasisPoints,
              unitOfMeasure: body.unitOfMeasure,
              trackInventory: body.trackInventory,
              isActive: body.isActive,
            })
          : api.post('/catalog/products', body),
      { success: editing ? 'Product updated' : 'Product created', onDone },
    );
  }

  const valid =
    name.trim().length > 1 &&
    (editing || variants.every((v) => v.sku.trim().length > 1 && v.unitPrice >= 0));

  return (
    <Modal title={editing ? `Edit ${product.name}` : 'New product'} onClose={onClose} wide>
      <FormGrid>
        <Field label="Name" wide>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Category">
          <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Uncategorised</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Tax treatment">
          <select className="input" value={taxCode} onChange={(e) => setTaxCode(e.target.value as Product['taxCode'])}>
            <option value="STANDARD">Standard rated (16%)</option>
            <option value="ZERO_RATED">Zero rated</option>
            <option value="EXEMPT">Exempt</option>
          </select>
        </Field>
        <Field label="Sold by">
          <select className="input" value={unitOfMeasure} onChange={(e) => setUom(e.target.value)}>
            <option value="EACH">Each</option>
            <option value="KG">Kilogram</option>
            <option value="LITRE">Litre</option>
            <option value="METRE">Metre</option>
            <option value="PACK">Pack</option>
          </select>
        </Field>
        <Field label="Options">
          <label className="row" style={{ fontSize: 14 }}>
            <input type="checkbox" checked={trackInventory} onChange={(e) => setTrack(e.target.checked)} />
            Track stock
          </label>
          <label className="row" style={{ fontSize: 14 }}>
            <input type="checkbox" checked={isActive} onChange={(e) => setActive(e.target.checked)} />
            Available for sale
          </label>
        </Field>
      </FormGrid>

      {!editing && (
        <>
          <div className="row" style={{ marginTop: 6, marginBottom: 8 }}>
            <strong style={{ fontSize: 14 }}>Variants</strong>
            <span className="muted" style={{ fontSize: 13 }}>
              One row per thing that scans separately — each size, each colour.
            </span>
            <div className="spacer" />
            <button className="btn ghost" onClick={() => setVariants((v) => [...v, blankVariant()])}>Add variant</button>
          </div>

          {variants.map((variant, index) => (
            <div key={index} className="card" style={{ marginBottom: 10, padding: 12 }}>
              <FormGrid columns={3}>
                <Field label="SKU">
                  <input
                    className="input mono"
                    value={variant.sku}
                    onChange={(e) => updateVariant(setVariants, index, { sku: e.target.value })}
                  />
                </Field>
                <Field label="Barcode">
                  <input
                    className="input mono"
                    value={variant.barcode}
                    onChange={(e) => updateVariant(setVariants, index, { barcode: e.target.value })}
                  />
                </Field>
                <Field label="Variant label">
                  <input
                    className="input"
                    placeholder="e.g. Size: M"
                    value={Object.entries(variant.attributes).map(([k, v]) => `${k}: ${v}`).join(', ')}
                    onChange={(e) => updateVariant(setVariants, index, { attributes: parseAttributes(e.target.value) })}
                  />
                </Field>
                <Field label="Selling price">
                  <MoneyInput value={variant.unitPrice} onChange={(cents) => updateVariant(setVariants, index, { unitPrice: cents })} />
                </Field>
                <Field label="Cost price">
                  <MoneyInput value={variant.costPrice} onChange={(cents) => updateVariant(setVariants, index, { costPrice: cents })} />
                </Field>
                <Field label="Reorder at">
                  <QuantityInput value={variant.reorderPoint} onChange={(milli) => updateVariant(setVariants, index, { reorderPoint: milli })} />
                </Field>
              </FormGrid>
              {variants.length > 1 && (
                <button className="btn ghost" onClick={() => setVariants((v) => v.filter((_, i) => i !== index))}>
                  Remove variant
                </button>
              )}
            </div>
          ))}
        </>
      )}

      {editing && (
        <p className="muted" style={{ fontSize: 13 }}>
          Prices are changed per variant so the change is dated and an offline sale
          can still be re-priced correctly. Use “Change price” on the row.
        </p>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <div className="spacer" />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !valid} onClick={save}>
          {editing ? 'Save changes' : 'Create product'}
        </button>
      </div>
    </Modal>
  );
}

function updateVariant(
  setVariants: React.Dispatch<React.SetStateAction<DraftVariant[]>>,
  index: number,
  patch: Partial<DraftVariant>,
): void {
  setVariants((list) => list.map((v, i) => (i === index ? { ...v, ...patch } : v)));
}

function parseAttributes(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of text.split(',')) {
    const [key, ...rest] = pair.split(':');
    const value = rest.join(':').trim();
    if (key?.trim() && value) result[key.trim()] = value;
  }
  return result;
}

/**
 * Price changes close the current history window and open a new one, so a sale
 * that syncs days later is still booked at the price the customer paid.
 */
function PriceChange({ variant, onClose, onDone }: { variant: Variant; onClose: () => void; onDone: () => void }) {
  const [unitPrice, setUnitPrice] = useState(variant.unitPrice);
  const [costPrice, setCostPrice] = useState(variant.costPrice);
  const [reason, setReason] = useState('');
  const { busy, run } = useMutation();

  return (
    <Modal title={`Change price — ${variant.sku}`} onClose={onClose}>
      <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
        Current price {formatCents(variant.unitPrice)}. The old price is kept with
        its dates, so past sales stay correct.
      </p>
      <Field label="New selling price">
        <MoneyInput value={unitPrice} onChange={setUnitPrice} autoFocus />
      </Field>
      <Field label="New cost price">
        <MoneyInput value={costPrice} onChange={setCostPrice} />
      </Field>
      <Field label="Reason">
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Supplier increase" />
      </Field>
      <div className="row">
        <div className="spacer" />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={busy || reason.trim().length < 3}
          onClick={() =>
            void run(
              () => api.patch(`/catalog/variants/${variant.id}/price`, { unitPrice, costPrice, reason }),
              { success: 'Price updated', onDone },
            )
          }
        >
          Update price
        </button>
      </div>
    </Modal>
  );
}
