// The navigation shell (plan P-A4). On start: open the encrypted local DB → not enrolled → EnrollScreen → cashier
// sign-in / PIN unlock (+ choosing an offline PIN after a first online sign-in) → the Main stack (Sell → Payment →
// Receipt, Sales today → Refund, Sync status, Settings). The sync engine runs whenever the device is enrolled. A
// persistent top bar shows the terminal, the cashier, online/offline and the outbox; a blocking banner appears under it
// while selling is blocked (device revoked, app update required, offline limits reached).
import { DefaultTheme, NavigationContainer, createNavigationContainerRef, type Theme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { resetDeviceToken } from './src/api/client';
import { cashierSession, useCashier } from './src/auth/cashierSession';
import { errorMessage } from './src/components/shell/format';
import { isExpoGo } from './src/config/runtime';
import type { EnrollmentState } from './src/contracts';
import { localStore } from './src/db/localStore';
import { deviceKey } from './src/device/deviceKey';
import type { SaleStackParamList } from './src/sale/navigation';
import { CashierLoginScreen } from './src/screens/CashierLoginScreen';
import EnrollScreen from './src/screens/EnrollScreen';
import { PaymentScreen } from './src/screens/PaymentScreen';
import { ReceiptScreen } from './src/screens/ReceiptScreen';
import { RefundScreen, type RefundParams } from './src/screens/RefundScreen';
import { SalesTodayScreen } from './src/screens/SalesTodayScreen';
import { SellScreen } from './src/screens/SellScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { SyncStatusScreen } from './src/screens/SyncStatusScreen';
import { syncEngine, useSyncStatus } from './src/sync/syncEngine';
import { Banner, Button } from './src/ui/components';
import { colors, font, radius, spacing } from './src/ui/theme';

// Sell / Payment / Receipt (names + params) come from the selling package (src/sale/navigation.ts).
export type RootStackParamList = SaleStackParamList & {
  SalesToday: undefined;
  Refund: RefundParams;
  SyncStatus: undefined;
  Settings: undefined;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    // Lets an untyped useNavigation() in any screen know these routes.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends RootStackParamList {}
  }
}

const Stack = createNativeStackNavigator<RootStackParamList>();
const navigationRef = createNavigationContainerRef<RootStackParamList>();

const navTheme: Theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: colors.primary,
    background: colors.background,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
  },
};

type Phase = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'enroll' } | { kind: 'ready' };

type Section = 'Sell' | 'SalesToday' | 'SyncStatus' | 'Settings';
const SECTIONS: { name: Section; label: string }[] = [
  { name: 'Sell', label: 'Sell' },
  { name: 'SalesToday', label: 'Sales' },
  { name: 'SyncStatus', label: 'Sync' },
  { name: 'Settings', label: 'Settings' },
];

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Shell />
    </SafeAreaProvider>
  );
}

function Shell() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [enrollment, setEnrollment] = useState<EnrollmentState | null>(null);
  const [terminalLabel, setTerminalLabel] = useState<string | null>(null);
  const cashier = useCashier((s) => s.cashier);
  const pinSetupRequired = useCashier((s) => s.pinSetupRequired);
  const lastSyncAt = useSyncStatus((s) => s.lastSyncAt);

  const boot = useCallback(async () => {
    setPhase({ kind: 'loading' });
    try {
      await localStore.init();
      const e = await localStore.getEnrollment();
      setEnrollment(e);
      setPhase(e ? { kind: 'ready' } : { kind: 'enroll' });
    } catch (err) {
      setPhase({ kind: 'error', message: errorMessage(err, 'The local database could not be opened.') });
    }
  }, []);

  useEffect(() => {
    boot();
  }, [boot]);

  // The sync engine runs for as long as the device is enrolled.
  const ready = phase.kind === 'ready';
  useEffect(() => {
    if (!ready) return;
    syncEngine.start();
    return () => syncEngine.stop();
  }, [ready]);

  // Terminal label: the latest bootstrap (names can change on the server), else what enrollment returned.
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    localStore
      .getBootstrap()
      .then((b) => {
        const t = b?.terminal ?? enrollment?.terminal;
        if (alive && t) setTerminalLabel(`${t.name} · ${t.branch.name}`);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [ready, enrollment, lastSyncAt]);

  const onEnrolled = useCallback(async () => {
    const e = await localStore.getEnrollment().catch(() => null);
    setEnrollment(e);
    setTerminalLabel(e ? `${e.terminal.name} · ${e.terminal.branch.name}` : null);
    setPhase(e ? { kind: 'ready' } : { kind: 'enroll' });
  }, []);

  // Only offered by Settings once the server has revoked this device. Sales and the outbox stay in the local DB
  // (localStore.clearEnrollment keeps them); enrollment, caches and offline PINs go.
  const reEnroll = useCallback(async () => {
    syncEngine.stop();
    await localStore.clearEnrollment();
    await deviceKey.deleteKey().catch(() => undefined);
    resetDeviceToken();
    cashierSession.logout();
    setEnrollment(null);
    setTerminalLabel(null);
    setPhase({ kind: 'enroll' });
  }, []);

  if (phase.kind === 'loading') {
    return (
      <PreviewFrame>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Opening GamotERP POS…</Text>
        </View>
      </PreviewFrame>
    );
  }
  if (phase.kind === 'error') {
    return (
      <PreviewFrame>
        <View style={styles.centered}>
          <Banner kind="danger" title="Can't start" message={phase.message} style={styles.errorBanner} />
          <Button title="Try again" onPress={boot} />
        </View>
      </PreviewFrame>
    );
  }
  if (phase.kind === 'enroll') {
    return (
      <SafeFrame>
        <EnrollScreen onEnrolled={onEnrolled} />
      </SafeFrame>
    );
  }

  const signedIn = !!cashier && !pinSetupRequired;
  return (
    <SafeFrame>
      <TopBar terminalLabel={terminalLabel} signedIn={signedIn} />
      <BlockingBanner signedIn={signedIn} />
      <View style={styles.body}>
        {signedIn ? <MainStack onReEnroll={reEnroll} /> : <CashierLoginScreen terminalLabel={terminalLabel} />}
      </View>
    </SafeFrame>
  );
}

function SafeFrame({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.frame,
        { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right, paddingBottom: insets.bottom },
      ]}
    >
      {isExpoGo ? <ExpoGoPreviewStrip /> : null}
      {children}
    </View>
  );
}

/** Loading / error screens: unchanged in a real build; in Expo Go framed like the rest so the preview strip shows. */
function PreviewFrame({ children }: { children: ReactNode }) {
  return isExpoGo ? <SafeFrame>{children}</SafeFrame> : <>{children}</>;
}

/** Expo Go preview mode (src/config/runtime.ts): always on screen, so nobody mistakes the phone for a real till. */
function ExpoGoPreviewStrip() {
  return (
    <View style={styles.previewStrip} accessibilityRole="alert">
      <Text style={styles.previewStripText} numberOfLines={2}>
        EXPO GO PREVIEW — not a secure POS · software device key, unencrypted local database · testing against a DEV
        server only
      </Text>
    </View>
  );
}

// ---- Main stack ------------------------------------------------------------------------------------------------

function MainStack({ onReEnroll }: { onReEnroll: () => Promise<void> }) {
  const track = () => currentRoute.set(navigationRef.getCurrentRoute()?.name ?? null);
  return (
    <NavigationContainer ref={navigationRef} theme={navTheme} onReady={track} onStateChange={track}>
      <Stack.Navigator
        initialRouteName="Sell"
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
          headerTintColor: colors.primary,
          headerTitleStyle: { fontWeight: '700' },
        }}
      >
        <Stack.Screen name="Sell" component={SellScreen} />
        <Stack.Screen name="Payment" component={PaymentScreen} />
        <Stack.Screen name="Receipt" component={ReceiptScreen} options={{ gestureEnabled: false }} />
        <Stack.Screen name="SalesToday" component={SalesTodayScreen} />
        <Stack.Screen name="Refund" component={RefundScreen} />
        <Stack.Screen name="SyncStatus" component={SyncStatusScreen} />
        <Stack.Screen name="Settings">{(props) => <SettingsScreen {...props} onReEnroll={onReEnroll} />}</Stack.Screen>
      </Stack.Navigator>
    </NavigationContainer>
  );
}

// The focused route, observable from the top bar (which lives outside the NavigationContainer).
const currentRoute = (() => {
  let value: string | null = null;
  const listeners = new Set<() => void>();
  return {
    set(name: string | null) {
      if (name === value) return;
      value = name;
      listeners.forEach((l) => l());
    },
    useValue(): string | null {
      const [, rerender] = useState(0);
      useEffect(() => {
        const l = () => rerender((n) => n + 1);
        listeners.add(l);
        return () => {
          listeners.delete(l);
        };
      }, []);
      return value;
    },
  };
})();

/** Top-bar sections act like tabs: the stack is always [Sell] or [Sell, section], so Back returns to Sell. */
function goToSection(name: Section) {
  if (!navigationRef.isReady()) return;
  navigationRef.reset(
    name === 'Sell' ? { index: 0, routes: [{ name: 'Sell' }] } : { index: 1, routes: [{ name: 'Sell' }, { name }] },
  );
}

// ---- Top bar ---------------------------------------------------------------------------------------------------

function TopBar({ terminalLabel, signedIn }: { terminalLabel: string | null; signedIn: boolean }) {
  const cashier = useCashier((s) => s.cashier);
  const online = useSyncStatus((s) => s.online);
  const syncing = useSyncStatus((s) => s.syncing);
  const pending = useSyncStatus((s) => s.pending);
  const rejected = useSyncStatus((s) => s.rejected);
  const current = currentRoute.useValue();
  const activeSection: Section | null =
    current === 'Payment' || current === 'Receipt' ? 'Sell' : current === 'Refund' ? 'SalesToday' : (current as Section | null);
  const pinMode = !!cashier && !cashierSession.isOnlineSession();

  return (
    <View style={styles.topBar}>
      <View style={styles.topLeft}>
        <Text style={styles.brand}>GamotERP POS</Text>
        <Text style={styles.terminal} numberOfLines={1}>
          {terminalLabel ?? '—'}
        </Text>
      </View>

      {signedIn ? (
        <View style={styles.sections}>
          {SECTIONS.map((s) => (
            <Pressable
              key={s.name}
              accessibilityRole="tab"
              accessibilityState={{ selected: activeSection === s.name }}
              onPress={() => goToSection(s.name)}
              style={[styles.section, activeSection === s.name && styles.sectionActive]}
            >
              <Text style={[styles.sectionText, activeSection === s.name && styles.sectionTextActive]}>{s.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <View style={styles.flex} />
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${online ? 'Online' : 'Offline'}, ${pending} waiting to sync`}
        disabled={!signedIn}
        onPress={() => goToSection('SyncStatus')}
        style={styles.status}
      >
        <View style={[styles.dot, { backgroundColor: online ? colors.accent : colors.warning }]} />
        <Text style={styles.statusText}>
          {online ? 'Online' : 'Offline'}
          {pending > 0 ? ` · ${pending} pending` : syncing ? ' · syncing' : ''}
          {rejected > 0 ? ` · ${rejected} rejected` : ''}
        </Text>
      </Pressable>

      {signedIn && cashier ? (
        <View style={styles.cashier}>
          <Text style={styles.cashierName} numberOfLines={1}>
            {cashier.name}
            {pinMode ? ' (PIN)' : ''}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Lock the till" onPress={() => cashierSession.lock()} style={styles.lockButton}>
            <Text style={styles.lockText}>Lock</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function BlockingBanner({ signedIn }: { signedIn: boolean }) {
  const revoked = useSyncStatus((s) => s.revoked);
  const updateRequired = useSyncStatus((s) => s.updateRequired);
  const blockedReason = useSyncStatus((s) => s.blockedReason);
  const current = currentRoute.useValue();
  if (!revoked && !updateRequired && !blockedReason) return null;
  // The Sell and Payment screens show the same reason in their own "Selling is paused" banner.
  if (signedIn && (current === 'Sell' || current === 'Payment')) return null;
  const title = revoked
    ? 'Device revoked — selling stopped'
    : updateRequired
      ? 'App update required — selling stopped'
      : 'Selling is blocked';
  const message =
    blockedReason ??
    (revoked
      ? 'This device was revoked on the server. Go to Settings → Re-enroll to enroll it again.'
      : `This app is older than the terminal's minimum version ${updateRequired}. Install the update to continue.`);
  const target: Section = revoked ? 'Settings' : 'SyncStatus';
  return (
    <Banner
      kind="danger"
      title={title}
      message={message}
      actionLabel={signedIn ? (revoked ? 'Settings' : 'Sync status') : undefined}
      onAction={signedIn ? () => goToSection(target) : undefined}
      style={styles.blocking}
    />
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, backgroundColor: colors.primary },
  body: { flex: 1, backgroundColor: colors.background },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, padding: spacing.xl },
  loadingText: { marginTop: spacing.md, color: colors.muted, fontSize: font.body },
  errorBanner: { marginBottom: spacing.lg, alignSelf: 'stretch' },
  flex: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.lg,
  },
  topLeft: { maxWidth: 260 },
  brand: { color: '#ffffff', fontSize: font.small, fontWeight: '700', opacity: 0.8 },
  terminal: { color: '#ffffff', fontSize: font.body, fontWeight: '700' },
  sections: { flex: 1, flexDirection: 'row', gap: spacing.xs },
  section: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.sm },
  sectionActive: { backgroundColor: '#ffffff' },
  sectionText: { color: '#ffffff', fontSize: font.body, fontWeight: '600' },
  sectionTextActive: { color: colors.primary },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  statusText: { color: '#ffffff', fontSize: font.small, fontWeight: '600' },
  cashier: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, maxWidth: 280 },
  cashierName: { color: '#ffffff', fontSize: font.body, fontWeight: '600', flexShrink: 1 },
  lockButton: {
    borderWidth: 1,
    borderColor: '#ffffff',
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  lockText: { color: '#ffffff', fontSize: font.small, fontWeight: '700' },
  blocking: { borderRadius: 0, borderTopWidth: 0, borderRightWidth: 0 },
  previewStrip: { backgroundColor: colors.warning, paddingHorizontal: spacing.lg, paddingVertical: spacing.xs },
  previewStripText: { color: '#ffffff', fontSize: font.small, fontWeight: '700', textAlign: 'center' },
});
