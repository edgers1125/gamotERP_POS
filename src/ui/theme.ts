// MedSource brand (same as the web app): no gradients. Shared by every screen — import, don't hardcode colours.
export const colors = {
  primary: '#033f74',
  accent: '#7ab537',
  green: '#445C44',
  greenSoft: '#527354',
  background: '#fffdf8',
  surface: '#ffffff',
  text: '#1c1c1c',
  muted: '#6b6b6b',
  border: '#dcdcdc',
  danger: '#b3261e',
  warning: '#9a6700',
  success: '#2e7d32',
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const radius = { sm: 6, md: 10, lg: 16 } as const;
export const font = { body: 16, small: 13, title: 22, huge: 32 } as const;
