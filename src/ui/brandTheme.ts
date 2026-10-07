// Dynamic brand colours — the POS follows the BRAND of whoever is using it, like the web app
// (GamotERP/apps/pharma/frontend/src/theme.ts createBrandTheme): the signed-in cashier's brand in the terminal's company
// (user_companies.company_brand_id → the company's default brand → standard MedSource); with no cashier signed in,
// the terminal's own display brand. Only primary/secondary (+ logo/name) change; every other token in theme.ts
// (surfaces, status colours, spacing, fonts) stays fixed so every brand still looks like the same product.
//
// HOW TO USE (every component that shows a brand colour):
//   const useStyles = makeStyles((c, t) => ({ title: { ...t.heading, color: c.primary } }));
//   function MyThing() { const styles = useStyles(); const c = useThemeColors(); … }
// Never read brand colours from the static `colors` in theme.ts inside a component — that's only the standard default.
import { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { create } from 'zustand';
import { colors as standardColors, fontFamily, font } from './theme';

export type ThemeColors = { -readonly [K in keyof typeof standardColors]: string };

export const STANDARD_PRIMARY = standardColors.primary;
export const STANDARD_SECONDARY = standardColors.secondary;
export const STANDARD_ACCENT = standardColors.accent;

// ---- colour math (flat colours only) --------------------------------------------------------------------------------
function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = (rgb: [number, number, number]) => `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
/** `amount` 0..1 of `b` mixed into `a`. */
function mix(a: string, b: string, amount: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return a;
  return toHex([0, 1, 2].map((i) => x[i]! + (y[i]! - x[i]!) * amount) as [number, number, number]);
}
function alpha(hex: string, a: number): string {
  const x = parseHex(hex);
  return x ? `rgba(${x[0]}, ${x[1]}, ${x[2]}, ${a})` : hex;
}
function luminance(hex: string): number {
  const x = parseHex(hex);
  if (!x) return 0;
  const [r, g, b] = x.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** White text when it reaches 3:1 on `bg` (MUI's rule), else near-black. */
export function contrastText(bg: string): string {
  const ratio = 1.05 / (luminance(bg) + 0.05);
  return ratio >= 3 ? '#ffffff' : '#1f1f1f';
}
const valid = (hex: string | null | undefined): hex is string => !!hex && parseHex(hex) !== null;

/**
 * The full token set for a brand. `accent` follows the web rule: a brand with its own secondary uses it as the accent;
 * the standard look keeps MedSource's accent.
 */
export function buildThemeColors(primaryIn?: string | null, secondaryIn?: string | null): ThemeColors {
  const primary = valid(primaryIn) ? primaryIn.toLowerCase() : STANDARD_PRIMARY;
  const secondary = valid(secondaryIn) ? secondaryIn.toLowerCase() : STANDARD_SECONDARY;
  const accent = valid(secondaryIn) ? secondary : STANDARD_ACCENT;
  const onPrimary = contrastText(primary);
  const onDark = onPrimary === '#ffffff';
  return {
    ...standardColors,
    primary,
    primaryDark: mix(primary, '#000000', 0.3),
    primarySoft: alpha(primary, 0.08),
    primarySoftStrong: alpha(primary, 0.16),
    onPrimary,
    onPrimaryMuted: onDark ? 'rgba(255, 255, 255, 0.74)' : 'rgba(0, 0, 0, 0.6)',
    onPrimaryPressed: onDark ? 'rgba(255, 255, 255, 0.14)' : 'rgba(0, 0, 0, 0.08)',
    primaryTint: mix(standardColors.background, primary, 0.08),
    primaryTintBorder: mix(standardColors.background, primary, 0.2),
    secondary,
    accent,
    accentSoft: alpha(accent, 0.16),
    green: primary,
    greenSoft: secondary,
    textSecondary: secondary,
  };
}

/** The text scale for a colour set (label/overline take the brand secondary, like the web's text.secondary). */
export function buildType(c: ThemeColors) {
  return {
    display: { fontFamily: fontFamily.bold, fontSize: font.huge, color: c.text },
    title: { fontFamily: fontFamily.semibold, fontSize: font.title, color: c.text },
    heading: { fontFamily: fontFamily.semibold, fontSize: 18, color: c.text },
    subtitle: { fontFamily: fontFamily.medium, fontSize: font.body, color: c.text },
    body: { fontFamily: fontFamily.regular, fontSize: font.body, color: c.text },
    bodyStrong: { fontFamily: fontFamily.semibold, fontSize: font.body, color: c.text },
    label: { fontFamily: fontFamily.medium, fontSize: 14, color: c.textSecondary },
    caption: { fontFamily: fontFamily.regular, fontSize: font.small, color: c.muted },
    overline: { fontFamily: fontFamily.semibold, fontSize: 12, letterSpacing: 0.8, textTransform: 'uppercase' as const, color: c.textSecondary },
    button: { fontFamily: fontFamily.medium, fontSize: 15, letterSpacing: 0.4 },
    money: { fontFamily: fontFamily.semibold, fontSize: font.body, color: c.text, fontVariant: ['tabular-nums' as const] },
  };
}
export type ThemeType = ReturnType<typeof buildType>;

// ---- the live brand ---------------------------------------------------------------------------------------------------
export interface AppliedBrand {
  /** Where it came from: the signed-in cashier's brand, the terminal's display brand, or the standard look. */
  source: 'cashier' | 'terminal' | 'standard';
  name: string | null;
  primary: string | null;
  secondary: string | null;
  /** A local file path (file://…) of the cached logo, or null. */
  logoUri: string | null;
}

interface BrandThemeState {
  brand: AppliedBrand;
  colors: ThemeColors;
  type: ThemeType;
  /** Switches the whole app to `brand` (no-op when nothing visible changes). */
  apply(brand: AppliedBrand): void;
}

const STANDARD_BRAND: AppliedBrand = { source: 'standard', name: null, primary: null, secondary: null, logoUri: null };
const initialColors = buildThemeColors();

export const useBrandTheme = create<BrandThemeState>()((set, get) => ({
  brand: STANDARD_BRAND,
  colors: initialColors,
  type: buildType(initialColors),
  apply(brand) {
    const cur = get().brand;
    if (
      cur.source === brand.source &&
      cur.name === brand.name &&
      cur.primary === brand.primary &&
      cur.secondary === brand.secondary &&
      cur.logoUri === brand.logoUri
    ) {
      return;
    }
    const colors = cur.primary === brand.primary && cur.secondary === brand.secondary ? get().colors : buildThemeColors(brand.primary, brand.secondary);
    set({ brand, colors, type: colors === get().colors ? get().type : buildType(colors) });
  },
}));

export const useThemeColors = (): ThemeColors => useBrandTheme((s) => s.colors);
export const useThemeType = (): ThemeType => useBrandTheme((s) => s.type);
export const useAppliedBrand = (): AppliedBrand => useBrandTheme((s) => s.brand);

/**
 * Themed StyleSheet factory: `const useStyles = makeStyles((c, t) => ({ … }))`, then `const styles = useStyles()` in
 * the component. Rebuilt only when the brand colours change (cached per colour set).
 */
export function makeStyles<T extends StyleSheet.NamedStyles<T>>(factory: (c: ThemeColors, t: ThemeType) => T): () => T {
  const cache = new WeakMap<ThemeColors, T>();
  return function useStyles(): T {
    const c = useThemeColors();
    const t = useThemeType();
    return useMemo(() => {
      let s = cache.get(c);
      if (!s) {
        s = StyleSheet.create(factory(c, t));
        cache.set(c, s);
      }
      return s;
    }, [c, t]);
  };
}
