import type { ReactNode } from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { makeStyles } from '../brandTheme';
import { radius, shadow, spacing } from '../theme';

// An MUI Paper/Card: white surface, 1px divider border, 10px corners, a faint elevation — with a brand-green top edge
// and title so sections don't read as plain white.
export interface CardProps {
  title?: string;
  right?: ReactNode;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function Card({ title, right, children, style }: CardProps) {
  const styles = useStyles();
  return (
    <View style={[styles.card, style]}>
      {title || right ? (
        <View style={styles.header}>
          {title ? <Text style={styles.title}>{title}</Text> : <View />}
          {right}
        </View>
      ) : null}
      {children}
    </View>
  );
}

const useStyles = makeStyles((c, t) => ({
  card: {
    backgroundColor: c.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    borderTopWidth: 3,
    borderTopColor: c.primary,
    padding: spacing.lg,
    marginBottom: spacing.md,
    ...shadow.card,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, marginBottom: spacing.md },
  title: { ...t.heading, flexShrink: 1, color: c.primary },
}));
