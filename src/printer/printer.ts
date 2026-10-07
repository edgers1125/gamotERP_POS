// Receipt printer seam (contracts.ts ReceiptPrinter). No ESC/POS library is installed yet, so there is no printer:
// `isAvailable()` is false and the on-screen receipt (always shown) is the receipt. To add one later, implement
// `EscPosDriver` (e.g. over Bluetooth/USB with a native module) and pass it to `setPrinterDriver` at startup — the
// Receipt screen already sends `receiptTextLines(...)` (src/sale/receipt.ts) to `printer.printText` when available.
import type { ReceiptPrinter } from '../contracts';

export interface EscPosDriver {
  /** True when a printer is paired/connected and ready. */
  isConnected(): Promise<boolean>;
  /** Writes raw ESC/POS bytes. */
  write(bytes: Uint8Array): Promise<void>;
}

let driver: EscPosDriver | null = null;

export function setPrinterDriver(next: EscPosDriver | null): void {
  driver = next;
}

const ESC = 0x1b;
const GS = 0x1d;

/** Plain-text receipt → ESC/POS bytes: init, text (non-ASCII replaced — most receipt printers lack ₱), feed, cut. */
export function escPosFromLines(lines: string[]): Uint8Array {
  // ₱ → P, dashes / middle dots → "-" (the receipt's "—" blanks and "·" separators); anything else non-ASCII → "?".
  const text =
    lines
      .join('\n')
      .replace(/₱/g, 'P')
      .replace(/[—–·]/g, '-')
      .replace(/[^\x0a\x20-\x7e]/g, '?') + '\n\n\n';
  const bytes: number[] = [ESC, 0x40]; // initialize
  for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i));
  bytes.push(GS, 0x56, 0x42, 0x00); // feed and partial cut
  return Uint8Array.from(bytes);
}

export const printer: ReceiptPrinter = {
  async isAvailable() {
    if (!driver) return false;
    try {
      return await driver.isConnected();
    } catch {
      return false;
    }
  },
  async printText(lines: string[]) {
    if (!driver) throw new Error('No receipt printer is connected — the receipt is on screen.');
    await driver.write(escPosFromLines(lines));
  },
};
