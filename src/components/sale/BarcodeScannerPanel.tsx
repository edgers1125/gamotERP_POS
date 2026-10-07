// Camera barcode scanning (expo-camera SDK 57: <CameraView barcodeScannerSettings onBarcodeScanned>), shown as a small
// panel in the Sell screen's left column, under the search box — never a full-screen popup, so the cart on the right
// stays fully visible while scanning. It stays open so several items can be scanned in a row; the same code is ignored
// for a moment so one item isn't added many times while it's held in front of the camera. Mounted only while open, so
// the camera is released as soon as it closes. (A USB/Bluetooth scanner needs none of this — it types into the search
// box.)
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult, type BarcodeType } from 'expo-camera';
import { Button } from '../../ui/components';
import { makeStyles, useThemeColors } from '../../ui/brandTheme';
import { radius, shadow, spacing } from '../../ui/theme';

const PRODUCT_BARCODES: BarcodeType[] = ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'code93', 'itf14', 'codabar', 'qr', 'datamatrix'];
const SAME_CODE_PAUSE_MS = 1500;
const CAMERA_HEIGHT = 220;

export interface ScanOutcome {
  ok: boolean;
  message: string;
}

export function BarcodeScannerPanel({
  onClose,
  onScanned,
}: {
  onClose: () => void;
  /** Handles one scanned code (adds the item) and says what happened. */
  onScanned: (code: string) => Promise<ScanOutcome>;
}) {
  const styles = useStyles();
  const theme = useThemeColors();
  const [permission, requestPermission] = useCameraPermissions();
  const [last, setLast] = useState<ScanOutcome | null>(null);
  const lastCode = useRef<{ code: string; at: number } | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [permission, requestPermission]);

  function handleScan(result: BarcodeScanningResult) {
    const code = result.data?.trim();
    if (!code || busy.current) return;
    const now = Date.now();
    if (lastCode.current && lastCode.current.code === code && now - lastCode.current.at < SAME_CODE_PAUSE_MS) return;
    lastCode.current = { code, at: now };
    busy.current = true;
    onScanned(code)
      .then(setLast)
      .catch(() => setLast({ ok: false, message: 'Couldn’t look up that barcode.' }))
      .finally(() => {
        busy.current = false;
      });
  }

  return (
    <View style={styles.card}>
      <View style={styles.camera}>
        {permission?.granted ? (
          <>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: PRODUCT_BARCODES }}
              onBarcodeScanned={handleScan}
            />
            <View style={styles.frame} pointerEvents="none" />
          </>
        ) : (
          <View style={styles.center}>
            <Text style={styles.permText}>
              {permission && !permission.canAskAgain
                ? 'Camera access is off for this app. Turn it on in Android Settings → Apps → GamotERP POS → Permissions.'
                : 'The camera is needed to scan barcodes.'}
            </Text>
            {permission?.canAskAgain !== false ? <Button title="Allow camera" compact onPress={() => void requestPermission()} /> : null}
          </View>
        )}
      </View>
      <View style={styles.footer}>
        {last ? (
          <View style={[styles.result, { backgroundColor: last.ok ? theme.successSoft : theme.dangerSoft }]}>
            <Text style={[styles.resultText, { color: last.ok ? theme.success : theme.danger }]} numberOfLines={2}>
              {last.message}
            </Text>
          </View>
        ) : (
          <Text style={styles.help}>Point the camera at the product’s barcode.</Text>
        )}
        <Button title="Close camera" variant="secondary" compact onPress={onClose} />
      </View>
    </View>
  );
}

const useStyles = makeStyles((c, t) => ({
  card: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    overflow: 'hidden',
    marginBottom: spacing.sm,
    ...shadow.card,
  },
  camera: { height: CAMERA_HEIGHT, backgroundColor: c.camera },
  frame: {
    position: 'absolute',
    top: '18%',
    bottom: '18%',
    left: '20%',
    right: '20%',
    borderWidth: 2,
    borderColor: c.onPrimary,
    borderRadius: radius.md,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, gap: spacing.md },
  permText: { ...t.body, color: c.onPrimary, textAlign: 'center', maxWidth: 420 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.sm, paddingLeft: spacing.md },
  help: { ...t.caption, flex: 1 },
  result: { flex: 1, borderRadius: radius.sm, paddingVertical: spacing.xs, paddingHorizontal: spacing.sm },
  resultText: { ...t.bodyStrong, fontSize: 14 },
}));
