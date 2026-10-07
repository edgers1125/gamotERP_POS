// JS API of the local `PosDisplay` Expo module (android/src/main/java/com/medsource/gamoterp/posdisplay/). Every string
// the display shows — money included — is formatted in JS; the native side only lays it out.

/** setConfig(JSON.stringify(config)) */
export interface PosDisplayNativeConfig {
  brandName: string;
  primaryColor: string; // #rrggbb
  secondaryColor: string; // #rrggbb
  logoPath: string | null; // absolute path of a cached file (saveImage)
  ads: { path: string; durationSeconds: number }[];
  /**
   * Colours: onPrimary, background (ivory — the display's text colour on its dark backdrop), text, muted, success,
   * border from src/ui/theme.ts, plus displayBackground (the backdrop) and accent (totals / change) — see
   * displayService's displayColors.
   */
  palette: Record<string, string>;
}

export interface PosDisplayRow {
  label: string;
  value: string;
  /** Shown in the display's accent colour (change due, total paid). Omitted = normal text. */
  accent?: boolean;
}

/** showCart(JSON.stringify(state)) */
export interface PosDisplayCartState {
  heading: string;
  greeting: string | null;
  lines: { name: string; detail: string; amount: string; discounts: PosDisplayRow[] }[];
  totals: (PosDisplayRow & { tone: 'normal' | 'discount' | 'muted' })[];
  grandTotalLabel: string;
  grandTotal: string;
  /** Cash received / change on the Payment screen ([] otherwise). */
  payment: PosDisplayRow[];
}

/** showThankYou(JSON.stringify(state)) */
export interface PosDisplayThankYouState {
  title: string;
  subtitle: string;
  rows: PosDisplayRow[];
}

export type PosDisplayEvents = {
  onDisplayChange: (event: { available: boolean }) => void;
};
