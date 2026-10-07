import type { ReactNode } from 'react';
import { RefreshControl, ScrollView, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { makeStyles, useThemeColors } from '../brandTheme';
import { spacing } from '../theme';

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

/** A screen body: ivory background, padding, optional title row, optional pull-to-refresh. The persistent top bar
 * (terminal, cashier, online/pending) and the safe-area insets are handled by the shell in App.tsx. */
export function Screen({ title, actions, children, scroll = true, refreshing, onRefresh, contentStyle }: ScreenProps) {
  const styles = useStyles();
  const c = useThemeColors();
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
      refreshControl={
        onRefresh ? (
          <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} colors={[c.primary]} tintColor={c.primary} />
        ) : undefined
      }
    >
      {header}
      {children}
    </ScrollView>
  );
}

const useStyles = makeStyles((c, t) => ({
  root: { flex: 1, backgroundColor: c.background },
  content: { padding: spacing.xl, flexGrow: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, marginBottom: spacing.lg },
  title: { ...t.title, flexShrink: 1 },
  actions: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
}));
