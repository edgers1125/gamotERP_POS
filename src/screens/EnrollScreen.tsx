// P-A1 — enroll this device as a POS terminal (docs/plans/pos-android-app.md "Security model" 1). The issuer's
// "Enroll POS" web page shows a one-time code as a QR (JSON EnrollmentQrPayload) — scan it, or type the server address
// and the code. The server's challenge names the terminal; the operator confirms it, then the device key is created
// (bound to the challenge), attested, and enrolled. On success the enrollment + device-owned counters are saved locally.
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
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
import { colors, font, radius, spacing } from '../ui/theme';

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

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Enroll this POS device</Text>
      <Text style={styles.subtitle}>
        On a computer, open GamotERP → Enroll POS, pick the terminal and generate an enrollment code. Then scan its QR
        code here, or type the server address and the code.
      </Text>

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
          <View style={[styles.card, styles.flex]}>
            <Text style={styles.cardTitle}>Scan the QR code</Text>
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

          <View style={[styles.card, styles.flex]}>
            <Text style={styles.cardTitle}>Or type it in</Text>
            <Text style={styles.label}>Server address</Text>
            <TextInput
              style={styles.input}
              value={serverUrl}
              onChangeText={setServerUrl}
              placeholder="https://erp.example.com/api"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <Text style={styles.label}>Enrollment code</Text>
            <TextInput
              style={[styles.input, styles.codeInput]}
              value={code}
              onChangeText={setCode}
              placeholder="ABCD2345EF"
              placeholderTextColor={colors.muted}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={20}
              returnKeyType="go"
              onSubmitEditing={() => void startChallenge(serverUrl, code)}
            />
            <Button label="Continue" onPress={() => void startChallenge(serverUrl, code)} />
          </View>
        </View>
      ) : null}

      {stage.kind === 'checking' ? <Busy text="Checking the code with the server…" /> : null}

      {stage.kind === 'preview' || stage.kind === 'enrolling' ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>This device will become</Text>
          <TerminalPreview challenge={stage.challenge} />
          {stage.challenge.attestation_mode === 'DEV' ? (
            <View style={styles.warningBox}>
              <Text style={styles.warningText}>
                The server is in development mode: device attestation is not enforced. Never use this for real sales.
              </Text>
            </View>
          ) : isExpoGo ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>
                This server enforces device attestation, which Expo Go can't provide — enrollment will be refused. Use
                a development server (POS_ATTESTATION_MODE=DEV) or the real POS build.
              </Text>
            </View>
          ) : null}
          {stage.kind === 'enrolling' ? (
            <Busy text="Creating the device key and enrolling…" />
          ) : (
            <View style={styles.buttonRow}>
              <Button label="Cancel" variant="secondary" onPress={cancel} style={styles.flex} />
              <Button
                label="Enroll this device"
                onPress={() => void enroll(stage.code, stage.challenge)}
                style={styles.flex}
              />
            </View>
          )}
        </View>
      ) : null}

      {stage.kind === 'saving' ? <Busy text="Saving the enrollment on this device…" /> : null}

      {stage.kind === 'saveFailed' ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Enrolled — not saved yet</Text>
          <Text style={styles.body}>
            Terminal {stage.result.terminal.name} ({stage.result.terminal.code}) at {stage.result.terminal.branch.name}.
          </Text>
          <Button label="Try saving again" onPress={() => void save(stage.result)} />
        </View>
      ) : null}

      {busy ? null : <Text style={styles.footnote}>Codes expire 10 minutes after they are generated.</Text>}
    </ScrollView>
  );
}

function TerminalPreview({ challenge }: { challenge: EnrollChallengeResponse }) {
  const t = challenge.terminal;
  return (
    <View style={styles.previewGrid}>
      <PreviewRow label="Company" value={t.company_name} />
      <PreviewRow label="Branch" value={t.branch_name} />
      <PreviewRow label="Terminal" value={`${t.terminal_name} (${t.terminal_code})`} />
    </View>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.previewRow}>
      <Text style={styles.previewLabel}>{label}</Text>
      <Text style={styles.previewValue}>{value}</Text>
    </View>
  );
}

function Busy({ text }: { text: string }) {
  return (
    <View style={styles.busy}>
      <ActivityIndicator color={colors.primary} />
      <Text style={styles.body}>{text}</Text>
    </View>
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
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' ? styles.buttonPrimary : styles.buttonSecondary,
        pressed && styles.buttonPressed,
        style,
      ]}
    >
      <Text style={variant === 'primary' ? styles.buttonPrimaryText : styles.buttonSecondaryText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.xl, gap: spacing.lg },
  title: { fontSize: font.title, fontWeight: '700', color: colors.primary },
  subtitle: { fontSize: font.body, color: colors.muted },
  row: { flexDirection: 'row', gap: spacing.lg, flexWrap: 'wrap' },
  flex: { flex: 1, minWidth: 280 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  cardTitle: { fontSize: font.body + 2, fontWeight: '700', color: colors.text },
  cameraWrap: { height: 260, borderRadius: radius.md, overflow: 'hidden', backgroundColor: '#000' },
  cameraIdle: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
  label: { fontSize: font.small, color: colors.muted, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: font.body,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  codeInput: { fontSize: font.title, letterSpacing: 3, fontWeight: '600' },
  button: { borderRadius: radius.md, paddingVertical: spacing.md, paddingHorizontal: spacing.lg, alignItems: 'center' },
  buttonPrimary: { backgroundColor: colors.primary },
  buttonSecondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.primary },
  buttonPressed: { opacity: 0.8 },
  buttonPrimaryText: { color: '#fff', fontSize: font.body, fontWeight: '700' },
  buttonSecondaryText: { color: colors.primary, fontSize: font.body, fontWeight: '700' },
  buttonRow: { flexDirection: 'row', gap: spacing.md },
  errorBox: { backgroundColor: '#fdecea', borderColor: colors.danger, borderWidth: 1, borderRadius: radius.md, padding: spacing.md },
  errorText: { color: colors.danger, fontSize: font.body },
  warningBox: { backgroundColor: '#fff8e1', borderColor: colors.warning, borderWidth: 1, borderRadius: radius.md, padding: spacing.md },
  warningText: { color: colors.warning, fontSize: font.small },
  previewGrid: { gap: spacing.sm },
  previewRow: { flexDirection: 'row', gap: spacing.md },
  previewLabel: { width: 110, fontSize: font.body, color: colors.muted },
  previewValue: { flex: 1, fontSize: font.body, fontWeight: '700', color: colors.text },
  busy: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
  body: { fontSize: font.body, color: colors.text },
  muted: { fontSize: font.body, color: colors.muted },
  footnote: { fontSize: font.small, color: colors.muted },
});

export default EnrollScreen;
