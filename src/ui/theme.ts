import type { TextStyle } from 'react-native';

// Mirrors the web app's MUI theme (GamotERP/apps/pharma/frontend/src/theme.ts + MUI defaults) so the POS looks like the same
// product: MedSource green primary, ivory background, white surfaces, Poppins, 10px corners, no gradients. Colour
// carries the structure (like the web's green sidebar): a solid primary top bar and dialog headers, sage-tinted bands
// for toolbars/panel headers, filled primary for what's selected — flat colours only.
// Shared by every screen — import, never hardcode colours (the receipt's black-on-white is the one exception).
export const colors = {
  // Brand (web: DEFAULT_PRIMARY / DEFAULT_SECONDARY)
  primary: '#445C44',
  primaryDark: '#2f402f', // pressed state (MUI's computed primary.dark)
  primarySoft: 'rgba(68, 92, 68, 0.08)', // selected / hover tint (MUI's alpha(primary, 0.08))
  primarySoftStrong: 'rgba(68, 92, 68, 0.16)',
  onPrimary: '#ffffff',
  onPrimaryMuted: 'rgba(255, 255, 255, 0.74)', // secondary text / idle tabs on a primary surface (top bar, sheet headers)
  onPrimaryPressed: 'rgba(255, 255, 255, 0.14)', // pressed state on a primary surface
  primaryTint: '#eef3ec', // flat sage wash for bands: toolbars, panel headers, table headers (web: alpha(primary, 0.08) on ivory)
  primaryTintBorder: '#d3dfd1',
  secondary: '#527354',
  accent: '#7ab537',
  accentSoft: 'rgba(122, 181, 55, 0.16)',
  // Legacy names kept so older code keeps compiling — same values as above.
  green: '#445C44',
  greenSoft: '#527354',

  // Surfaces
  background: '#fffdf8', // web background.default (ivory)
  surface: '#ffffff', // web background.paper
  surfaceMuted: '#f7f6f1', // table headers, read-only fields, disabled inputs
  border: '#e0e0e0', // MUI divider on white
  borderStrong: '#c4c4c4', // outlined input border

  // Text (web: text.primary = MUI default, text.secondary = the brand secondary)
  text: '#1f1f1f',
  textSecondary: '#527354',
  muted: '#6b6b6b', // captions, placeholders
  disabled: '#9e9e9e',

  // Status (MUI palette + Alert "standard" backgrounds)
  danger: '#d32f2f',
  dangerSoft: '#fdeded',
  warning: '#ed6c02',
  warningSoft: '#fff4e5',
  success: '#2e7d32',
  successSoft: '#edf7ed',
  info: '#0288d1',
  infoSoft: '#e5f6fd',
  dangerDark: '#c62828', // pressed state of a contained danger button (MUI error.dark)

  // Overlays
  backdrop: 'rgba(0, 0, 0, 0.5)', // behind dialogs/sheets (MUI Backdrop)
  scrim: 'rgba(0, 0, 0, 0.6)', // text panels laid over the camera preview
  camera: '#000000', // camera preview background
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
// Web theme shape.borderRadius = 10.
export const radius = { sm: 6, md: 10, lg: 14, pill: 999 } as const;
export const font = { body: 16, small: 13, title: 22, huge: 32 } as const;

// Poppins, loaded in App.tsx (@expo-google-fonts/poppins). Falls back to the system font until loaded.
export const fontFamily = {
  regular: 'Poppins_400Regular',
  medium: 'Poppins_500Medium',
  semibold: 'Poppins_600SemiBold',
  bold: 'Poppins_700Bold',
} as const;

// Text styles — spread into StyleSheet entries (`{ ...type.body, color: colors.muted }`). On Android a custom font
// ignores fontWeight, so weight comes from the family: NEVER set fontWeight next to these, pick the right one.
export const type = {
  display: { fontFamily: fontFamily.bold, fontSize: font.huge, color: colors.text },
  title: { fontFamily: fontFamily.semibold, fontSize: font.title, color: colors.text },
  heading: { fontFamily: fontFamily.semibold, fontSize: 18, color: colors.text },
  subtitle: { fontFamily: fontFamily.medium, fontSize: font.body, color: colors.text },
  body: { fontFamily: fontFamily.regular, fontSize: font.body, color: colors.text },
  bodyStrong: { fontFamily: fontFamily.semibold, fontSize: font.body, color: colors.text },
  label: { fontFamily: fontFamily.medium, fontSize: 14, color: colors.textSecondary },
  caption: { fontFamily: fontFamily.regular, fontSize: font.small, color: colors.muted },
  overline: { fontFamily: fontFamily.semibold, fontSize: 12, letterSpacing: 0.8, textTransform: 'uppercase', color: colors.textSecondary },
  button: { fontFamily: fontFamily.medium, fontSize: 15, letterSpacing: 0.4 },
  money: { fontFamily: fontFamily.semibold, fontSize: font.body, color: colors.text, fontVariant: ['tabular-nums'] },
} satisfies Record<string, TextStyle>;

// Subtle elevation for cards/sheets (MUI elevation 1). Headers and the sidebar use a border instead.
export const shadow = {
  card: { shadowColor: '#000000', shadowOpacity: 0.06, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  sheet: { shadowColor: '#000000', shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
} as const;
