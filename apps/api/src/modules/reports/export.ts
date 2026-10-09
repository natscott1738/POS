import PDFDocument from 'pdfkit';
import { formatCents } from '@pos/shared';

/**
 * CSV writer with correct escaping. A product name containing a comma, a quote or
 * a newline must not be able to corrupt the file or shift columns.
 */
export function toCsv(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (rows.length === 0) return '';
  const headers = columns ?? Object.keys(rows[0] as Record<string, unknown>);
  const lines = [headers.map(escapeCsv).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCsv(row[h])).join(','));
  }
  // CRLF and a BOM so Excel opens UTF-8 correctly on Windows tills.
  return `﻿${lines.join('\r\n')}\r\n`;
}

function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);

  // Neutralise spreadsheet formula injection: a cell starting with =, +, -, @
  // is executed by Excel and Sheets when the file is opened.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;

  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export interface PdfSection {
  title: string;
  columns: Array<{ key: string; label: string; align?: 'left' | 'right'; money?: boolean }>;
  rows: Array<Record<string, unknown>>;
}

export interface PdfReportOptions {
  title: string;
  subtitle?: string;
  meta: Array<[string, string]>;
  sections: PdfSection[];
  currency?: string;
}

/** Renders a report to PDF. Returns a Buffer so the caller controls the response. */
export function renderPdf(options: PdfReportOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const currency = options.currency ?? 'KES';

    doc.fontSize(18).font('Helvetica-Bold').text(options.title);
    if (options.subtitle) {
      doc.moveDown(0.2).fontSize(10).font('Helvetica').fillColor('#555').text(options.subtitle);
    }
    doc.fillColor('#000').moveDown(0.6);

    doc.fontSize(9).font('Helvetica');
    for (const [label, value] of options.meta) {
      doc.text(`${label}: ${value}`);
    }
    doc.moveDown(0.8);

    for (const section of options.sections) {
      if (doc.y > 720) doc.addPage();

      doc.fontSize(12).font('Helvetica-Bold').text(section.title);
      doc.moveDown(0.3);

      const usableWidth = doc.page.width - 80;
      const columnWidth = usableWidth / section.columns.length;
      let y = doc.y;

      doc.fontSize(8).font('Helvetica-Bold');
      section.columns.forEach((col, i) => {
        doc.text(col.label, 40 + i * columnWidth, y, {
          width: columnWidth - 4,
          align: col.align ?? 'left',
        });
      });

      y = doc.y + 2;
      doc.moveTo(40, y).lineTo(doc.page.width - 40, y).strokeColor('#ccc').stroke();
      doc.y = y + 4;

      doc.fontSize(8).font('Helvetica');
      for (const row of section.rows) {
        // Start a new page before the row rather than letting it run off the edge.
        if (doc.y > 780) {
          doc.addPage();
          doc.fontSize(8).font('Helvetica');
        }
        const rowY = doc.y;
        let maxY = rowY;
        section.columns.forEach((col, i) => {
          const raw = row[col.key];
          const text = col.money ? formatCents(Number(raw ?? 0), currency) : String(raw ?? '');
          doc.text(text, 40 + i * columnWidth, rowY, {
            width: columnWidth - 4,
            align: col.align ?? (col.money ? 'right' : 'left'),
          });
          maxY = Math.max(maxY, doc.y);
        });
        doc.y = maxY + 2;
      }
      doc.moveDown(1);
    }

    // Page numbers, added once the total is known.
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc
        .fontSize(7)
        .fillColor('#888')
        .text(
          `Page ${i + 1} of ${range.count}  ·  Generated ${new Date().toISOString()}`,
          40,
          doc.page.height - 30,
          { width: doc.page.width - 80, align: 'center' },
        );
    }

    doc.end();
  });
}

/** Filenames are sanitised so a report name can never traverse a path. */
export function safeFilename(base: string, extension: string): string {
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 80);
  return `${cleaned || 'report'}.${extension}`;
}
