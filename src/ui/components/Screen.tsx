import type { ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, font, spacing } from '../theme';

export interface ScreenProps {
  title?: string;
  /** Rendered to the right of the title. */
  actions?: ReactNode;
  children?: ReactNode;
  /** Wrap the content in a ScrollView (default true). */
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  contentStyle?: StyleProp<ViewStyle>;
}

/** A screen body: brand background, padding, optional title row, optional pull-to-refresh. The persistent top bar
 * (terminal, cashier, online/pending) and the safe-area insets are handled by the shell in App.tsx. */
export function Screen({ title, actions, children, scroll = true, refreshing, onRefresh, contentStyle }: ScreenProps) {
  const header =
    title || actions ? (
      <View style={styles.header}>
        {title ? <Text style={styles.title}>{title}</Text> : <View />}
        {actions ? <View style={styles.actions}>{actions}</View> : null}
      </View>
    ) : null;
  if (!scroll) {
    return (
      <View style={[styles.root, styles.content, contentStyle]}>
        {header}
        {children}
      </View>
    );
  }
  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, contentStyle]}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined}
    >
      {header}
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, flexGrow: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  title: { fontSize: font.title, fontWeight: '700', color: colors.primary },
  actions: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
});
