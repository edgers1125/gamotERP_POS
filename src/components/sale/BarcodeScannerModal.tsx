// Camera barcode scanning (expo-camera SDK 57: <CameraView barcodeScannerSettings onBarcodeScanned>). Stays open so
// several items can be scanned in a row; the same code is ignored for a moment so one item isn't added many times
// while it's held in front of the camera. (A USB/Bluetooth scanner needs none of this — it types into the search box.)
import { useEffect, useRef, useState } from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult, type BarcodeType } from 'expo-camera';
import { Button } from '../../ui/components';
import { colors, font, radius, spacing } from '../../ui/theme';

const PRODUCT_BARCODES: BarcodeType[] = ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'code93', 'itf14', 'codabar', 'qr', 'datamatrix'];
const SAME_CODE_PAUSE_MS = 1500;

export interface ScanOutcome {
  ok: boolean;
  message: string;
}

export function BarcodeScannerModal({
  visible,
  onClose,
  onScanned,
}: {
  visible: boolean;
  onClose: () => void;
  /** Handles one scanned code (adds the item) and says what happened. */
  onScanned: (code: string) => Promise<ScanOutcome>;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [last, setLast] = useState<ScanOutcome | null>(null);
  const lastCode = useRef<{ code: string; at: number } | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (!visible) {
      setLast(null);
      lastCode.current = null;
    } else if (permission && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [visible, permission, requestPermission]);

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
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} supportedOrientations={['landscape', 'portrait']}>
      <View style={styles.root}>
        {permission?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: PRODUCT_BARCODES }}
            onBarcodeScanned={visible ? handleScan : undefined}
          />
        ) : (
          <View style={styles.center}>
            <Text style={styles.permText}>
              {permission && !permission.canAskAgain
                ? 'Camera access is off for this app. Turn it on in Android Settings → Apps → GamotERP POS → Permissions.'
                : 'The camera is needed to scan barcodes.'}
            </Text>
            {permission?.canAskAgain !== false ? <Button title="Allow camera" onPress={() => void requestPermission()} /> : null}
          </View>
        )}
        <View style={styles.frame} pointerEvents="none" />
        <View style={styles.bottom}>
          {last ? (
            <View style={[styles.result, { backgroundColor: last.ok ? colors.success : colors.danger }]}>
              <Text style={styles.resultText}>{last.message}</Text>
            </View>
          ) : (
            <Text style={styles.help}>Point the camera at the product’s barcode.</Text>
          )}
          <Button title="Done" variant="secondary" onPress={onClose} style={{ minWidth: 160 }} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.lg },
  permText: { color: '#fff', fontSize: font.body, textAlign: 'center', maxWidth: 520 },
  frame: {
    position: 'absolute',
    top: '22%',
    left: '25%',
    right: '25%',
    bottom: '32%',
    borderWidth: 3,
    borderColor: colors.accent,
    borderRadius: radius.md,
  },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  help: { flex: 1, color: '#fff', fontSize: font.body },
  result: { flex: 1, borderRadius: radius.sm, padding: spacing.md },
  resultText: { color: '#fff', fontSize: font.body, fontWeight: '600' },
});
