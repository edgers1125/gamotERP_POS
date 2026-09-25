import { forwardRef } from 'react';
import { StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';

import { colors, font, radius, spacing } from '../theme';

export interface TextFieldProps extends TextInputProps {
  label?: string;
  error?: string | null;
  hint?: string | null;
  containerStyle?: StyleProp<ViewStyle>;
}

export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
  { label, error, hint, containerStyle, style, editable = true, ...rest },
  ref,
) {
  return (
    <View style={[styles.container, containerStyle]}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput
        ref={ref}
        placeholderTextColor={colors.muted}
        editable={editable}
        style={[styles.input, !!error && styles.inputError, !editable && styles.inputDisabled, style]}
        {...rest}
      />
      {error ? <Text style={styles.error}>{error}</Text> : hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: { marginBottom: spacing.md },
  label: { fontSize: font.small, color: colors.muted, marginBottom: spacing.xs, fontWeight: '600' },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    fontSize: font.body,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  inputError: { borderColor: colors.danger },
  inputDisabled: { backgroundColor: colors.background, color: colors.muted },
  error: { color: colors.danger, fontSize: font.small, marginTop: spacing.xs },
  hint: { color: colors.muted, fontSize: font.small, marginTop: spacing.xs },
});
