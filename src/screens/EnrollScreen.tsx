// P-A1 — enroll this device as a POS terminal (docs/plans/pos-android-app.md "Security model" 1). The issuer's
// "Enroll POS" web page shows a one-time code as a QR (JSON EnrollmentQrPayload) — scan it, or type the server address
// and the code. The server's challenge names the terminal; the operator confirms it, then the device key is created
// (bound to the challenge), attested, and enrolled. On success the enrollment + device-owned counters are saved locally.
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import type { EnrollChallengeResponse, EnrollResponse, EnrollmentQrPayload } from '@pos-api/contract';
import { api, resetDeviceToken } from '../api/client';
import { isExpoGo } from '../config/runtime';
import { normalizeBaseUrl, serverConfig } from '../config/serverConfig';
import { ApiError } from '../contracts';
import { localStore } from '../db/localStore';
import { makeStyles, useThemeColors } from '../ui/brandTheme';
import { radius, shadow, spacing } from '../ui/theme';

type Stage =
  | { kind: 'input' }
  | { kind: 'checking' }
  | { kind: 'preview'; code: string; challenge: EnrollChallengeResponse }
  | { kind: 'enrolling'; code: string; challenge: EnrollChallengeResponse }
  | { kind: 'saving'; result: EnrollResponse }
  | { kind: 'saveFailed'; result: EnrollResponse };

function parseQr(data: string): EnrollmentQrPayload | null {
  try {
    const v = JSON.parse(data) as Partial<EnrollmentQrPayload> | null;
    if (!v || typeof v !== 'object' || v.v !== 1) return null;
    if (typeof v.server_url !== 'string' || !v.server_url || typeof v.code !== 'string' || !v.code) return null;
    return { v: 1, server_url: v.server_url, code: v.code };
  } catch {
    return null;
  }
}

function describeError(e: unknown, serverUrl: string): string {
  if (e instanceof ApiError) {
    if (e.isNetwork && e.code !== 'NOT_CONFIGURED') {
      return `${e.message}. Server: ${serverUrl || '(none)'}`;
    }
    if (e.status === 429) return 'Too many attempts — wait a few minutes, then try again.';
    return e.message;
  }
  if (e instanceof Error && e.message) return e.message;
  return 'Something went wrong — try again.';
}

export interface EnrollScreenProps {
  onEnrolled: () => void;
}

export function EnrollScreen({ onEnrolled }: EnrollScreenProps) {
  const styles = useStyles();
  const [stage, setStage] = useState<Stage>({ kind: 'input' });
  const [serverUrl, setServerUrl] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const scanLock = useRef(false);

  useEffect(() => {
    let alive = true;
    serverConfig.getBaseUrl().then(
      (url) => {
        if (alive && url) setServerUrl((current) => current || url);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);

  const startChallenge = useCallback(async (rawUrl: string, rawCode: string) => {
    setError(null);
    const trimmedCode = rawCode.trim();
    let url: string;
    try {
      url = normalizeBaseUrl(rawUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Enter the server address');
      return;
    }
    if (!trimmedCode) {
      setError('Enter the enrollment code shown on the Enroll POS page');
      return;
    }
    setStage({ kind: 'checking' });
    try {
      await serverConfig.setBaseUrl(url);
      resetDeviceToken();
      const challenge = await api.enrollChallenge(trimmedCode);
      setStage({ kind: 'preview', code: trimmedCode, challenge });
    } catch (e) {
      setError(describeError(e, url));
      setStage({ kind: 'input' });
    }
  }, []);

  const handleScan = useCallback(
    (result: BarcodeScanningResult) => {
      if (scanLock.current) return;
      scanLock.current = true;
      const payload = parseQr(result.data);
      if (!payload) {
        setError('That QR code is not a GamotERP POS enrollment code. Scan the code on the Enroll POS page.');
        // Let the operator re-aim without the same code firing again immediately.
        setTimeout(() => {
          scanLock.current = false;
        }, 1500);
        return;
      }
      setScanning(false);
      setServerUrl(payload.server_url);
      setCode(payload.code);
      void startChallenge(payload.server_url, payload.code).finally(() => {
        scanLock.current = false;
      });
    },
    [startChallenge],
  );

  const openScanner = useCallback(async () => {
    setError(null);
    let granted = permission?.granted ?? false;
    if (!granted) {
      const res = await requestPermission();
      granted = res.granted;
    }
    if (!granted) {
      setError('Camera permission is needed to scan the QR code — or type the server address and code instead.');
      return;
    }
    scanLock.current = false;
    setScanning(true);
  }, [permission, requestPermission]);

  const save = useCallback(
    async (result: EnrollResponse) => {
      setStage({ kind: 'saving', result });
      try {
        await localStore.saveEnrollment(
          { device_id: result.device_id, terminal: result.terminal, enrolled_at: result.server_time },
          result.counters,
        );
        onEnrolled();
      } catch (e) {
        setError(
          `The server enrolled this device, but saving it here failed: ${
            e instanceof Error ? e.message : 'unknown error'
          }. Try saving again.`,
        );
        setStage({ kind: 'saveFailed', result });
      }
    },
    [onEnrolled],
  );

  const enroll = useCallback(
    async (enrollCode: string, challenge: EnrollChallengeResponse) => {
      setError(null);
      setStage({ kind: 'enrolling', code: enrollCode, challenge });
      let result: EnrollResponse;
      try {
        result = await api.enroll({ code: enrollCode, challenge });
      } catch (e) {
        setError(describeError(e, serverUrl));
        // The challenge is single-use; start over with a (possibly new) code.
        setStage({ kind: 'input' });
        return;
      }
      resetDeviceToken();
      await save(result);
    },
    [save, serverUrl],
  );

  const cancel = useCallback(() => {
    setError(null);
    setStage({ kind: 'input' });
  }, []);

  const busy = stage.kind === 'checking' || stage.kind === 'enrolling' || stage.kind === 'saving';

  // The scan + type-it-in step shows two columns side by side on a landscape tablet; every other step is one column.
  const wide = stage.kind === 'input';

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={[styles.panel, wide && styles.panelWide]}>
        <View style={styles.strip} />
        <View style={styles.panelBody}>
          <View style={styles.header}>
            <Text style={styles.title}>Enroll this POS device</Text>
            <Text style={styles.subtitle}>
              On a computer, open GamotERP → Enroll POS, pick the terminal and generate an enrollment code. Then scan
              its QR code here, or type the server address and the code.
            </Text>
          </View>

          {isExpoGo ? (
            <View style={styles.warningBox}>
              <Text style={styles.warningText}>
                Expo Go preview: this phone uses a software key and an unencrypted database, and can only enroll with a
                server running in DEV attestation mode (POS_ATTESTATION_MODE=DEV). On a phone, the server address is
                http://&lt;your PC's LAN IP&gt;:4001/api — not 10.0.2.2 (that only works in the Android emulator).
              </Text>
            </View>
          ) : null}

          {error ? (
            <View style={styles.errorBox} accessibilityRole="alert">
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {stage.kind === 'input' ? (
            <View style={styles.row}>
              <View style={[styles.section, styles.flex]}>
                <Text style={styles.sectionTitle}>Scan the QR code</Text>
                {scanning ? (
                  <View style={styles.cameraWrap}>
                    <CameraView
                      style={StyleSheet.absoluteFill}
                      facing="back"
                      barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                      onBarcodeScanned={handleScan}
                    />
                  </View>
                ) : (
                  <View style={[styles.cameraWrap, styles.cameraIdle]}>
                    <Text style={styles.muted}>The camera is off.</Text>
                  </View>
                )}
                {scanning ? (
                  <Button label="Stop scanning" variant="secondary" onPress={() => setScanning(false)} />
                ) : (
                  <Button label="Scan QR code" onPress={() => void openScanner()} />
                )}
              </View>

              <View style={[styles.section, styles.flex]}>
                <Text style={styles.sectionTitle}>Or type it in</Text>
                <Field label="Server address">
                  <OutlinedInput
                    value={serverUrl}
                    onChangeText={setServerUrl}
                    placeholder="https://erp.example.com/api"
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                  />
                </Field>
                <Field label="Enrollment code">
                  <OutlinedInput
                    style={styles.codeInput}
                    value={code}
                    onChangeText={setCode}
                    placeholder="ABCD2345EF"
                    autoCapitalize="characters"
                    autoCorrect={false}
                    maxLength={20}
                    returnKeyType="go"
                    onSubmitEditing={() => void startChallenge(serverUrl, code)}
                  />
                </Field>
                <View style={styles.flexSpacer} />
                <Button label="Continue" onPress={() => void startChallenge(serverUrl, code)} />
              </View>
            </View>
          ) : null}

          {stage.kind === 'checking' ? <Busy text="Checking the code with the server…" /> : null}

          {stage.kind === 'preview' || stage.kind === 'enrolling' ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>This device will become</Text>
              <TerminalPreview challenge={stage.challenge} />
              {stage.challenge.attestation_mode === 'DEV' ? (
                <View style={styles.warningBox}>
                  <Text style={styles.warningText}>
                    The server is in development mode: device attestation is not enforced. Never use this for real
                    sales.
                  </Text>
                </View>
              ) : isExpoGo ? (
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>
                    This server enforces device attestation, which Expo Go can't provide — enrollment will be refused.
                    Use a development server (POS_ATTESTATION_MODE=DEV) or the real POS build.
                  </Text>
                </View>
              ) : null}
              {stage.kind === 'enrolling' ? (
                <Busy text="Creating the device key and enrolling…" />
              ) : (
                <View style={styles.buttonRow}>
                  <Button label="Cancel" variant="secondary" onPress={cancel} style={styles.flexButton} />
                  <Button
                    label="Enroll this device"
                    onPress={() => void enroll(stage.code, stage.challenge)}
                    style={styles.flexButton}
                  />
                </View>
              )}
            </View>
          ) : null}

          {stage.kind === 'saving' ? <Busy text="Saving the enrollment on this device…" /> : null}

          {stage.kind === 'saveFailed' ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Enrolled — not saved yet</Text>
              <Text style={styles.body}>
                Terminal {stage.result.terminal.name} ({stage.result.terminal.code}) at {stage.result.terminal.branch.name}.
              </Text>
              <Button label="Try saving again" onPress={() => void save(stage.result)} />
            </View>
          ) : null}

          {busy ? null : <Text style={styles.footnote}>Codes expire 10 minutes after they are generated.</Text>}
        </View>
      </View>
    </ScrollView>
  );
}

function TerminalPreview({ challenge }: { challenge: EnrollChallengeResponse }) {
  const styles = useStyles();
  const t = challenge.terminal;
  return (
    <View style={styles.previewGrid}>
      <PreviewRow label="Company" value={t.company_name} />
      <PreviewRow label={t.terminal_type === 'ATTENDANCE_ONLY' ? 'Location' : 'Branch'} value={t.branch_name} />
      <PreviewRow label="Terminal" value={`${t.terminal_name} (${t.terminal_code})`} />
      {/* POS or attendance-only (GamotERP docs/plans/attendance-pos-only.md); absent from an older server = POS. */}
      <PreviewRow label="Type" value={t.terminal_type === 'ATTENDANCE_ONLY' ? 'Attendance only (staff clock in/out — no selling)' : 'POS (selling till)'} />
    </View>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  const styles = useStyles();
  return (
    <View style={styles.previewRow}>
      <Text style={styles.previewLabel}>{label}</Text>
      <Text style={styles.previewValue}>{value}</Text>
    </View>
  );
}

function Busy({ text }: { text: string }) {
  const styles = useStyles();
  const c = useThemeColors();
  return (
    <View style={styles.busy}>
      <ActivityIndicator color={c.primary} />
      <Text style={styles.body}>{text}</Text>
    </View>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

/** An MUI-style outlined input: strong border at rest, primary border while focused. */
function OutlinedInput({ style, onFocus, onBlur, ...rest }: TextInputProps) {
  const styles = useStyles();
  const c = useThemeColors();
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      {...rest}
      placeholderTextColor={c.muted}
      onFocus={(e) => {
        setFocused(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        onBlur?.(e);
      }}
      style={[styles.input, focused && styles.inputFocused, style]}
    />
  );
}

function Button({
  label,
  onPress,
  variant = 'primary',
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles();
  const primary = variant === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.buttonPrimary : styles.buttonSecondary,
        pressed && (primary ? styles.buttonPrimaryPressed : styles.buttonSecondaryPressed),
        style,
      ]}
    >
      <Text style={primary ? styles.buttonPrimaryText : styles.buttonSecondaryText}>{label}</Text>
    </Pressable>
  );
}

const useStyles = makeStyles((c, t) => ({
  screen: { flex: 1, backgroundColor: c.background },
  content: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  // A centred card like the web app's sign-in page: white paper, a primary strip on top.
  panel: {
    width: '100%',
    maxWidth: 480,
    backgroundColor: c.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    overflow: 'hidden',
    ...shadow.card,
  },
  panelWide: { maxWidth: 880 },
  strip: { height: 6, backgroundColor: c.primary },
  panelBody: { padding: spacing.xxl, gap: spacing.lg },
  header: { gap: spacing.sm },
  title: { ...t.title, color: c.primary },
  subtitle: { ...t.body, color: c.muted },
  row: { flexDirection: 'row', gap: spacing.xl, flexWrap: 'wrap' },
  flex: { flex: 1, minWidth: 280 },
  flexButton: { flex: 1 },
  flexSpacer: { flexGrow: 1 },
  section: { gap: spacing.md },
  sectionTitle: { ...t.heading },
  cameraWrap: { height: 260, borderRadius: radius.md, overflow: 'hidden', backgroundColor: c.text },
  cameraIdle: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.surfaceMuted,
    borderWidth: 1,
    borderColor: c.border,
  },
  field: { gap: spacing.xs },
  label: { ...t.label },
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
  inputFocused: { borderColor: c.primary },
  codeInput: { ...t.title, letterSpacing: 3 },
  // MUI-style buttons: 48 high, 12×20 padding, radius.md — contained primary / outlined secondary.
  button: {
    minHeight: 48,
    paddingVertical: spacing.md,
    paddingHorizontal: 20,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPrimary: { backgroundColor: c.primary, borderColor: c.primary },
  buttonPrimaryPressed: { backgroundColor: c.primaryDark, borderColor: c.primaryDark },
  buttonSecondary: { backgroundColor: c.surface, borderColor: c.primary },
  buttonSecondaryPressed: { backgroundColor: c.primarySoft },
  buttonPrimaryText: { ...t.button, color: c.onPrimary },
  buttonSecondaryText: { ...t.button, color: c.primary },
  buttonRow: { flexDirection: 'row', gap: spacing.md },
  errorBox: { backgroundColor: c.dangerSoft, borderRadius: radius.md, padding: spacing.md },
  errorText: { ...t.body, color: c.danger },
  warningBox: { backgroundColor: c.warningSoft, borderRadius: radius.md, padding: spacing.md },
  warningText: { ...t.caption, color: c.warning },
  previewGrid: {
    gap: spacing.sm,
    padding: spacing.lg,
    backgroundColor: c.surfaceMuted,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
  },
  previewRow: { flexDirection: 'row', gap: spacing.md },
  previewLabel: { ...t.body, width: 110, color: c.muted },
  previewValue: { ...t.bodyStrong, flex: 1 },
  busy: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
  body: { ...t.body },
  muted: { ...t.body, color: c.muted },
  footnote: { ...t.caption },
}));

export default EnrollScreen;
