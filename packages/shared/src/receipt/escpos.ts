/**
 * ESC/POS command builder for 80mm thermal receipt printers.
 *
 * Built as raw bytes rather than HTML-and-print because a browser print dialog
 * cannot control paper cut, drawer kick, or column alignment on a 42-character
 * roll — and a cashier should never see a print dialog at all.
 *
 * Commands used here are the common subset supported by Epson TM-series, Star,
 * and the Chinese clones that dominate the Kenyan market.
 */

const ESC = 0x1b;
const GS = 0x1d;

export const PAPER_WIDTH_CHARS = 42;

export class EscPosBuilder {
  private readonly chunks: number[] = [];

  /** Resets the printer to a known state; always call first. */
  init(): this {
    return this.raw(ESC, 0x40);
  }

  raw(...bytes: number[]): this {
    this.chunks.push(...bytes);
    return this;
  }

  /** Latin-1 so Kenyan shop names with accents survive the round trip. */
  text(value: string): this {
    for (const char of value) {
      const code = char.codePointAt(0) ?? 63;
      this.chunks.push(code < 256 ? code : 63);
    }
    return this;
  }

  line(value = ''): this {
    return this.text(value).raw(0x0a);
  }

  align(mode: 'left' | 'center' | 'right'): this {
    return this.raw(ESC, 0x61, mode === 'left' ? 0 : mode === 'center' ? 1 : 2);
  }

  bold(on: boolean): this {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }

  underline(on: boolean): this {
    return this.raw(ESC, 0x2d, on ? 1 : 0);
  }

  /** Double height/width for the total, which the customer actually reads. */
  size(width: 1 | 2, height: 1 | 2): this {
    return this.raw(GS, 0x21, ((width - 1) << 4) | (height - 1));
  }

  feed(lines = 1): this {
    return this.raw(ESC, 0x64, lines);
  }

  /** Full cut, after feeding enough paper to clear the cutter. */
  cut(): this {
    return this.feed(4).raw(GS, 0x56, 0x00);
  }

  /**
   * Fires the cash drawer solenoid. Drawers are wired to the printer, so this is
   * the only way to open one under software control.
   */
  openDrawer(pin: 0 | 1 = 0): this {
    return this.raw(ESC, 0x70, pin, 0x19, 0xfa);
  }

  /** Left-aligned label with a right-aligned value on one line. */
  columns(left: string, right: string, width = PAPER_WIDTH_CHARS): this {
    const available = width - right.length;
    const trimmed = left.length > available ? `${left.slice(0, Math.max(0, available - 1))}…` : left;
    const padding = Math.max(1, width - trimmed.length - right.length);
    return this.line(`${trimmed}${' '.repeat(padding)}${right}`);
  }

  rule(character = '-', width = PAPER_WIDTH_CHARS): this {
    return this.line(character.repeat(width));
  }

  /** QR code, used for the eTIMS fiscal code once that integration lands. */
  qr(data: string, moduleSize = 6): this {
    const bytes = [...data].map((c) => c.charCodeAt(0) & 0xff);
    const length = bytes.length + 3;
    return this
      .raw(GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0)
      .raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, moduleSize)
      .raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x30)
      .raw(GS, 0x28, 0x6b, length & 0xff, (length >> 8) & 0xff, 0x31, 0x50, 0x30, ...bytes)
      .raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30);
  }

  build(): Uint8Array {
    return new Uint8Array(this.chunks);
  }
}

/** Wraps text to the paper width without splitting words where avoidable. */
export function wrap(text: string, width = PAPER_WIDTH_CHARS): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
    while (current.length > width) {
      lines.push(current.slice(0, width));
      current = current.slice(width);
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function centre(text: string, width = PAPER_WIDTH_CHARS): string {
  if (text.length >= width) return text.slice(0, width);
  const pad = Math.floor((width - text.length) / 2);
  return `${' '.repeat(pad)}${text}`;
}
