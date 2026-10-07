import { forwardRef, useState } from 'react';
import { Text, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';

import { makeStyles, useThemeColors } from '../brandTheme';
import { radius, spacing } from '../theme';
import { markTillActivity } from '../../auth/tillLock';

// An MUI "outlined" text field: label above, 1px border that becomes 2px primary while focused (red on error).
export interface TextFieldProps extends TextInputProps {
  label?: string;
  error?: string | null;
  hint?: string | null;
  containerStyle?: StyleProp<ViewStyle>;
}

export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
  { label, error, hint, containerStyle, style, editable = true, onFocus, onBlur, onChangeText, multiline, ...rest },
  ref,
) {
  const styles = useStyles();
  const c = useThemeColors();
  const [focused, setFocused] = useState(false);
  const hasError = !!error;
  const active = focused && editable;
  return (
    <View style={[styles.container, containerStyle]}>
      {label ? (
        <Text style={[styles.label, active && styles.labelFocused, hasError && styles.labelError, !editable && styles.labelDisabled]}>
          {label}
        </Text>
      ) : null}
      <TextInput
        ref={ref}
        placeholderTextColor={c.muted}
        selectionColor={c.primary}
        cursorColor={c.primary}
        editable={editable}
        multiline={multiline}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        // Typing on the on-screen keyboard (another window) counts as activity for the till's idle lock.
        onChangeText={
          onChangeText
            ? (t) => {
                markTillActivity();
                onChangeText(t);
              }
            : undefined
        }
        style={[
          styles.input,
          multiline && styles.multiline,
          active && styles.inputFocused,
          hasError && styles.inputError,
          !editable && styles.inputDisabled,
          style,
        ]}
        {...rest}
      />
      {error ? <Text style={styles.error}>{error}</Text> : hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
});

const useStyles = makeStyles((c, t) => ({
  container: { marginBottom: spacing.md },
  label: { ...t.label, marginBottom: spacing.xs },
  labelFocused: { color: c.primary },
  labelError: { color: c.danger },
  labelDisabled: { color: c.disabled },
  input: {
    ...t.body,
    minHeight: 48,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: c.surface,
  },
  multiline: { minHeight: 88, textAlignVertical: 'top' },
  // 2px border; padding drops by 1 so the text doesn't move when focus changes.
  inputFocused: { borderWidth: 2, borderColor: c.primary, paddingHorizontal: spacing.md - 1, paddingVertical: spacing.sm - 1 },
  inputError: { borderColor: c.danger },
  inputDisabled: { backgroundColor: c.surfaceMuted, borderColor: c.border, color: c.muted },
  error: { ...t.caption, color: c.danger, marginTop: spacing.xs },
  hint: { ...t.caption, marginTop: spacing.xs },
}));
