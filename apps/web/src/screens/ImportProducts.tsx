import { useState } from 'react';
import { formatCents } from '@pos/shared';
import { api, download, ApiError } from '../lib/api.js';
import { useMutation } from '../lib/useApi.js';
import { useAuth, toast } from '../lib/store.js';
import { Modal } from '../components/Modal.js';
import { Badge } from '../components/ui.js';

interface Preview {
  rows: Array<{
    name: string; sku: string; barcode?: string; unitPrice: number;
    costPrice: number; taxCode: string; openingStock: number;
  }>;
  issues: Array<{ row: number; field: string; message: string }>;
  summary: { products: number; variants: number; withStock: number };
}

/**
 * Bulk catalogue import.
 *
 * Validates the whole file and shows every problem before anything is written,
 * because a half-imported catalogue is harder to clean up than an empty one.
 */
export default function ImportProducts({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const storeId = useAuth((s) => s.storeId);
  const [csv, setCsv] = useState('');
  const [filename, setFilename] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const { busy, run } = useMutation();

  async function readFile(file: File): Promise<void> {
    const text = await file.text();
    setCsv(text);
    setFilename(file.name);
    setPreview(null);
    try {
      setPreview(await api.post<Preview>('/catalog/import/validate', { csv: text }));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not read that file');
    }
  }

  const clean = preview !== null && preview.issues.length === 0;

  return (
    <Modal title="Import products" onClose={onClose} wide>
      <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
        Upload a CSV of your catalogue. Rows sharing a product name become variants
        of the same product. Nothing is saved until the file is completely clean.
      </p>

      <div className="row" style={{ marginBottom: 14 }}>
        <button
          className="btn ghost"
          onClick={() => void download('/catalog/import/template', 'product-import-template.csv')}
        >
          Download template
        </button>
        <div className="spacer" />
        <label className="btn primary" style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
          Choose CSV
          <input
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void readFile(file);
            }}
          />
        </label>
      </div>

      {filename && <p className="muted" style={{ fontSize: 13 }}>Reading <strong>{filename}</strong></p>}

      {preview && (
        <>
          <div className="stat-grid" style={{ marginBottom: 14 }}>
            <div className="stat">
              <div className="label">Products</div>
              <div className="value" style={{ fontSize: 20 }}>{preview.summary.products}</div>
            </div>
            <div className="stat">
              <div className="label">Variants</div>
              <div className="value" style={{ fontSize: 20 }}>{preview.summary.variants}</div>
            </div>
            <div className="stat">
              <div className="label">With opening stock</div>
              <div className="value" style={{ fontSize: 20 }}>{preview.summary.withStock}</div>
            </div>
          </div>

          {preview.issues.length > 0 ? (
            <div className="banner error">
              <strong>{preview.issues.length} problem(s) found.</strong> Fix these in your
              spreadsheet and upload again.
              <table style={{ marginTop: 10 }}>
                <thead><tr><th>Row</th><th>Column</th><th>Problem</th></tr></thead>
                <tbody>
                  {preview.issues.slice(0, 20).map((issue, i) => (
                    <tr key={i}>
                      <td className="mono">{issue.row}</td>
                      <td className="mono">{issue.field}</td>
                      <td>{issue.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.issues.length > 20 && (
                <p className="muted" style={{ fontSize: 12 }}>…and {preview.issues.length - 20} more.</p>
              )}
            </div>
          ) : (
            <>
              <div className="row" style={{ marginBottom: 8 }}>
                <Badge tone="success">Ready to import</Badge>
                <span className="muted" style={{ fontSize: 13 }}>Showing the first 10 rows.</span>
              </div>
              <table>
                <thead>
                  <tr><th>Product</th><th>SKU</th><th className="num">Price</th><th>VAT</th><th className="num">Opening stock</th></tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 10).map((row, i) => (
                    <tr key={i}>
                      <td>{row.name}</td>
                      <td className="mono">{row.sku}</td>
                      <td className="num">{formatCents(row.unitPrice)}</td>
                      <td className="muted">{row.taxCode.replace('_', ' ').toLowerCase()}</td>
                      <td className="num">{row.openingStock / 1000}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      <div className="row" style={{ marginTop: 16 }}>
        <div className="spacer" />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={busy || !clean || !storeId}
          onClick={() =>
            void run(
              () => api.post('/catalog/import/apply', { storeId, csv }),
              {
                success: `Imported ${preview?.summary.variants ?? 0} product(s)`,
                onDone: () => { onDone(); onClose(); },
              },
            )
          }
        >
          Import {preview ? `${preview.summary.variants} row(s)` : ''}
        </button>
      </div>
    </Modal>
  );
}
