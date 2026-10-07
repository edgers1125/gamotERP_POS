// The navigation shell (plan P-A4). On start: open the encrypted local DB → not enrolled → EnrollScreen → cashier
// sign-in / PIN unlock (+ choosing an offline PIN after a first online sign-in) → the Main stack (Sell → Payment →
// Receipt, Sales today → Refund, Sync status, Settings). The sync engine runs whenever the device is enrolled. A
// persistent top bar shows the terminal, the cashier, online/offline and the outbox; a blocking banner appears under it
// while selling is blocked (device revoked, app update required, offline limits reached). Styled like the web app:
// white header with a divider, MedSource green actions (colors.primary), ivory content, Poppins (loaded below).
// Colours follow the BRAND (src/ui/brandTheme.ts, fed by src/ui/brandSource.ts — the signed-in cashier's brand, else
// the terminal's display brand, else standard): every style here comes from makeStyles, and the top bar shows the
// brand's logo + name.
// Attendance (GamotERP docs/plans/attendance-pos-only.md): a signed-in till whose terminal HR bound as a kiosk gets an
// "Attendance" section (staff punch without locking the till); an ATTENDANCE_ONLY terminal (bootstrap / enrollment
// terminal_type) has no cashier at all — its app is Attendance | Check-in | Settings.
import { Poppins_400Regular } from '@expo-google-fonts/poppins/400Regular';
import { Poppins_500Medium } from '@expo-google-fonts/poppins/500Medium';
import { Poppins_600SemiBold } from '@expo-google-fonts/poppins/600SemiBold';
import { Poppins_700Bold } from '@expo-google-fonts/poppins/700Bold';
import { DefaultTheme, NavigationContainer, createNavigationContainerRef, type Theme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, Image, Pressable, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { resetDeviceToken } from './src/api/client';
import { isAttendanceOnlyTerminal, loadKiosk, refreshKiosk, useAttendanceKiosk } from './src/attendance/attendanceKiosk';
import { cashierSession, useCashier } from './src/auth/cashierSession';
import { markTillActivity, useTillAutoLock, useTillLockNotice } from './src/auth/tillLock';
import { idleLockMinutesOf } from './src/auth/tillLockPolicy';
import { errorMessage } from './src/components/shell/format';
import { isExpoGo } from './src/config/runtime';
import type { EnrollmentState } from './src/contracts';
import { localStore } from './src/db/localStore';
import { useCustomerDisplay } from './src/display/useCustomerDisplay';
import { deviceKey } from './src/device/deviceKey';
import type { SaleStackParamList } from './src/sale/navigation';
import { AttendanceKioskScreen } from './src/screens/AttendanceKioskScreen';
import { CashDrawerScreen } from './src/screens/CashDrawerScreen';
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
import { makeStyles, useAppliedBrand, useThemeColors, useThemeType, type ThemeColors } from './src/ui/brandTheme';
import { brandSource } from './src/ui/brandSource';
import { Banner, Button } from './src/ui/components';
import { fontFamily, radius, spacing } from './src/ui/theme';

// Sell / Payment / Receipt (names + params) come from the selling package (src/sale/navigation.ts).
export type RootStackParamList = SaleStackParamList & {
  Attendance: undefined;
  SalesToday: undefined;
  Refund: RefundParams;
  CashDrawer: undefined;
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

function buildNavTheme(c: ThemeColors): Theme {
  return {
    ...DefaultTheme,
    colors: {
      ...DefaultTheme.colors,
      primary: c.primary,
      background: c.background,
      card: c.surface,
      text: c.text,
      border: c.border,
    },
    fonts: {
      regular: { fontFamily: fontFamily.regular, fontWeight: 'normal' },
      medium: { fontFamily: fontFamily.medium, fontWeight: 'normal' },
      bold: { fontFamily: fontFamily.semibold, fontWeight: 'normal' },
      heavy: { fontFamily: fontFamily.bold, fontWeight: 'normal' },
    },
  };
}

// Poppins weights used by theme.ts's `type` styles. Only these four files are bundled (per-weight imports).
const POPPINS = { Poppins_400Regular, Poppins_500Medium, Poppins_600SemiBold, Poppins_700Bold };
// Never hold the app on fonts: if loading neither finishes nor fails by then, start with the system font.
const FONT_WAIT_MS = 3000;

type Phase = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'enroll' } | { kind: 'ready' };

type Section = 'Sell' | 'Attendance' | 'SalesToday' | 'CashDrawer' | 'SyncStatus' | 'Settings';
const SECTIONS: { name: Section; label: string }[] = [
  { name: 'Sell', label: 'Sell' },
  { name: 'Attendance', label: 'Attendance' }, // only while the kiosk is ON (TopBar filters it)
  { name: 'SalesToday', label: 'Sales' },
  { name: 'CashDrawer', label: 'Cash drawer' },
  { name: 'SyncStatus', label: 'Check-in' },
  { name: 'Settings', label: 'Settings' },
];
// An attendance-only tablet: no Sell / Sales / Cash drawer, no cashier.
const ATTENDANCE_ONLY_SECTIONS: { name: Section; label: string }[] = [
  { name: 'Attendance', label: 'Attendance' },
  { name: 'SyncStatus', label: 'Check-in' },
  { name: 'Settings', label: 'Settings' },
];

export default function App() {
  const [fontsLoaded, fontError] = useFonts(POPPINS);
  const [fontWaitOver, setFontWaitOver] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setFontWaitOver(true), FONT_WAIT_MS);
    return () => clearTimeout(t);
  }, []);
  // Loaded, failed (system font fallback) or timed out — render. Until then a blank page in the app's background.
  const fontsSettled = fontsLoaded || !!fontError || fontWaitOver;
  const styles = useStyles();
  // The status-bar strip sits on the brand primary: light icons on a dark primary, dark icons on a light one.
  const onPrimary = useThemeColors().onPrimary;
  return (
    <SafeAreaProvider>
      <StatusBar style={onPrimary === '#ffffff' ? 'light' : 'dark'} />
      {fontsSettled ? <Shell /> : <View style={styles.fontWait} />}
    </SafeAreaProvider>
  );
}

function Shell() {
  const styles = useStyles();
  const c = useThemeColors();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [enrollment, setEnrollment] = useState<EnrollmentState | null>(null);
  const [terminalLabel, setTerminalLabel] = useState<string | null>(null);
  // An ATTENDANCE_ONLY terminal (fixed for its life): enrollment's terminal first, then each bootstrap.
  const [attendanceOnly, setAttendanceOnly] = useState(false);
  // The branch's till auto-lock (bootstrap `till`; src/auth/tillLock.ts) — minutes without a touch, 0 = off.
  const [idleLockMinutes, setIdleLockMinutes] = useState(() => idleLockMinutesOf(null));
  const cashier = useCashier((s) => s.cashier);
  const pinSetupRequired = useCashier((s) => s.pinSetupRequired);
  const lastSyncAt = useSyncStatus((s) => s.lastSyncAt);

  const boot = useCallback(async () => {
    setPhase({ kind: 'loading' });
    try {
      await localStore.init();
      const e = await localStore.getEnrollment();
      setEnrollment(e);
      setAttendanceOnly(isAttendanceOnlyTerminal(e?.terminal));
      setPhase(e ? { kind: 'ready' } : { kind: 'enroll' });
    } catch (err) {
      setPhase({ kind: 'error', message: errorMessage(err, 'The local database could not be opened.') });
    }
  }, []);

  useEffect(() => {
    boot();
  }, [boot]);

  // The customer-facing second monitor follows the cart (no-op without one / in Expo Go).
  useCustomerDisplay();

  // Idle / background auto-lock + the sticky Sold By reset on lock (docs: sales-incentives.md "As built — cashier vs
  // seller, idle lock"). Off (0) until enrolled.
  useTillAutoLock(phase.kind === 'ready' ? idleLockMinutes : 0);

  // The sync engine runs for as long as the device is enrolled.
  const ready = phase.kind === 'ready';
  useEffect(() => {
    if (!ready) return;
    syncEngine.start();
    return () => syncEngine.stop();
  }, [ready]);

  // Attendance kiosk mode: the cached on/off + employee list (the sync engine re-asks the server after each bootstrap).
  useEffect(() => {
    if (!ready) return;
    void loadKiosk().then(() => refreshKiosk({ force: true }));
  }, [ready]);

  // The app's colours follow the cashier's brand (else the terminal's) while enrolled; standard otherwise.
  useEffect(() => {
    if (!ready) return;
    brandSource.start();
    return () => brandSource.stop();
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
        if (alive && t) setAttendanceOnly(isAttendanceOnlyTerminal(t));
        if (alive && b) setIdleLockMinutes(idleLockMinutesOf(b));
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
    setAttendanceOnly(isAttendanceOnlyTerminal(e?.terminal));
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
    setAttendanceOnly(false);
    setPhase({ kind: 'enroll' });
  }, []);

  if (phase.kind === 'loading') {
    return (
      <PreviewFrame>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={c.primary} />
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

  // An attendance-only tablet never has a cashier: its sections are always open (no sign-in, nothing to sell).
  if (attendanceOnly) {
    return (
      <SafeFrame>
        <TopBar terminalLabel={terminalLabel} signedIn={false} attendanceOnly />
        <BlockingBanner signedIn attendanceOnly />
        <WarningBanner signedIn />
        <View style={styles.body}>
          <MainStack onReEnroll={reEnroll} attendanceOnly />
        </View>
      </SafeFrame>
    );
  }
  const signedIn = !!cashier && !pinSetupRequired;
  return (
    <SafeFrame>
      <TopBar terminalLabel={terminalLabel} signedIn={signedIn} />
      <BlockingBanner signedIn={signedIn} />
      <WarningBanner signedIn={signedIn} />
      <View style={styles.body}>
        {signedIn ? <MainStack onReEnroll={reEnroll} /> : <LockedHome terminalLabel={terminalLabel} />}
      </View>
    </SafeFrame>
  );
}

/**
 * The locked till. On a terminal HR made an attendance kiosk (src/attendance/, CLAUDE.md "Attendance kiosk mode") staff
 * punch here — "Staff attendance" (the default) — and a cashier switches to "Cashier sign-in" to sell; the attendance
 * screen itself never offers selling. Not a kiosk → the cashier sign-in as before.
 */
function LockedHome({ terminalLabel }: { terminalLabel: string | null }) {
  const styles = useStyles();
  const kioskOn = useAttendanceKiosk((s) => s.mode === 'ON');
  const [view, setView] = useState<'attendance' | 'cashier'>('attendance');
  // Why the till locked by itself (idle / app left) — until someone signs in (src/auth/tillLock.ts).
  const lockNotice = useTillLockNotice((s) => s.message);
  const notice = lockNotice ? <Banner kind="info" message={lockNotice} style={styles.lockNotice} /> : null;
  if (!kioskOn)
    return (
      <View style={styles.flex}>
        {notice}
        <CashierLoginScreen terminalLabel={terminalLabel} />
      </View>
    );
  const tabs: { key: 'attendance' | 'cashier'; label: string }[] = [
    { key: 'attendance', label: 'Staff attendance' },
    { key: 'cashier', label: 'Cashier sign-in' },
  ];
  return (
    <View style={styles.flex}>
      {notice}
      <View style={styles.launcher}>
        {tabs.map((t) => {
          const active = view === t.key;
          return (
            <Pressable
              key={t.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => setView(t.key)}
              style={[styles.launcherTab, active && styles.launcherTabActive]}
            >
              <Text style={[styles.launcherText, active && styles.launcherTextActive]}>{t.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.flex}>{view === 'attendance' ? <AttendanceKioskScreen /> : <CashierLoginScreen terminalLabel={terminalLabel} />}</View>
    </View>
  );
}

function SafeFrame({ children }: { children: ReactNode }) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.frame,
        { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right, paddingBottom: insets.bottom },
      ]}
      // Every touch in the app window restarts the till's idle timer (never takes the touch).
      onStartShouldSetResponderCapture={() => {
        markTillActivity();
        return false;
      }}
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
  const styles = useStyles();
  return (
    <View style={styles.previewStrip} accessibilityRole="alert">
      <Text style={styles.previewStripText} numberOfLines={2}>
        <Text style={styles.previewStripTitle}>EXPO GO PREVIEW — not a secure POS</Text> · software device key, unencrypted
        local database · testing against a DEV server only
      </Text>
    </View>
  );
}

// ---- Main stack ------------------------------------------------------------------------------------------------

function MainStack({ onReEnroll, attendanceOnly = false }: { onReEnroll: () => Promise<void>; attendanceOnly?: boolean }) {
  homeSection = attendanceOnly ? 'Attendance' : 'Sell';
  const c = useThemeColors();
  const t = useThemeType();
  const navTheme = useMemo(() => buildNavTheme(c), [c]);
  const track = () => currentRoute.set(navigationRef.getCurrentRoute()?.name ?? null);
  return (
    <NavigationContainer ref={navigationRef} theme={navTheme} onReady={track} onStateChange={track}>
      <Stack.Navigator
        // A different stack (sections) per mode: remount when the terminal turns out to be attendance-only.
        key={attendanceOnly ? 'attendance-only' : 'pos'}
        initialRouteName={attendanceOnly ? 'Attendance' : 'Sell'}
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: c.background },
          // Only used if a screen turns its native header on: white, no shadow.
          headerStyle: { backgroundColor: c.surface },
          headerShadowVisible: false,
          headerTintColor: c.primary,
          headerTitleStyle: { fontFamily: t.heading.fontFamily, fontSize: t.heading.fontSize, color: c.text },
        }}
      >
        {attendanceOnly ? null : (
          <>
            <Stack.Screen name="Sell" component={SellScreen} />
            <Stack.Screen name="Payment" component={PaymentScreen} />
            <Stack.Screen name="Receipt" component={ReceiptScreen} options={{ gestureEnabled: false }} />
            <Stack.Screen name="SalesToday" component={SalesTodayScreen} />
            <Stack.Screen name="Refund" component={RefundScreen} />
            <Stack.Screen name="CashDrawer" component={CashDrawerScreen} />
          </>
        )}
        <Stack.Screen name="Attendance" component={AttendanceKioskScreen} />
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

/** The stack's first route: Sell, or Attendance on an attendance-only tablet (set by MainStack). */
let homeSection: Section = 'Sell';

/** Top-bar sections act like tabs: the stack is always [home] or [home, section], so Back returns to the home section. */
function goToSection(name: Section) {
  if (!navigationRef.isReady()) return;
  navigationRef.reset(
    name === homeSection ? { index: 0, routes: [{ name: homeSection }] } : { index: 1, routes: [{ name: homeSection }, { name }] },
  );
}

// ---- Top bar ---------------------------------------------------------------------------------------------------

function TopBar({ terminalLabel, signedIn, attendanceOnly = false }: { terminalLabel: string | null; signedIn: boolean; attendanceOnly?: boolean }) {
  const styles = useStyles();
  const c = useThemeColors();
  const brand = useAppliedBrand();
  const [logoFailed, setLogoFailed] = useState(false);
  useEffect(() => setLogoFailed(false), [brand.logoUri]);
  const cashier = useCashier((s) => s.cashier);
  const online = useSyncStatus((s) => s.online);
  const syncing = useSyncStatus((s) => s.syncing);
  const pending = useSyncStatus((s) => s.pending);
  const rejected = useSyncStatus((s) => s.rejected);
  const kioskOn = useAttendanceKiosk((s) => s.mode === 'ON');
  // The sections shown: an attendance-only tablet's three; a till's, with Attendance only while the kiosk is ON.
  const sections = attendanceOnly ? ATTENDANCE_ONLY_SECTIONS : SECTIONS.filter((x) => x.name !== 'Attendance' || kioskOn);
  const showSections = signedIn || attendanceOnly;
  const current = currentRoute.useValue();
  const activeSection: Section | null =
    current === 'Payment' || current === 'Receipt' ? 'Sell' : current === 'Refund' ? 'SalesToday' : (current as Section | null);
  const pinMode = !!cashier && !cashierSession.isOnlineSession();
  // Sync pill: soft status background + strong text (red when something was rejected, amber offline, green online).
  const statusTone =
    rejected > 0
      ? { bg: c.dangerSoft, fg: c.danger }
      : online
        ? { bg: c.successSoft, fg: c.success }
        : { bg: c.warningSoft, fg: c.warning };

  return (
    <View style={styles.topBar}>
      <View style={styles.topLeft}>
        {brand.logoUri && !logoFailed ? (
          // White rounded chip: keeps any logo legible on any brand primary.
          <View style={styles.logoChip}>
            <Image
              source={{ uri: brand.logoUri }}
              style={styles.logo}
              resizeMode="contain"
              onError={() => setLogoFailed(true)}
              accessibilityIgnoresInvertColors
            />
          </View>
        ) : null}
        <View style={styles.topLeftText}>
          <Text style={styles.brand} numberOfLines={1}>
            {brand.name ?? 'GamotERP POS'}
          </Text>
          <Text style={styles.terminal} numberOfLines={1}>
            {terminalLabel ?? '—'}
          </Text>
        </View>
      </View>

      {showSections ? (
        <View style={styles.sections}>
          {sections.map((s) => {
            const active = activeSection === s.name;
            return (
              <Pressable
                key={s.name}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                onPress={() => goToSection(s.name)}
                style={({ pressed }) => [styles.section, pressed && styles.sectionPressed]}
              >
                <Text style={[styles.sectionText, active && styles.sectionTextActive]}>{s.label}</Text>
                <View style={[styles.sectionIndicator, active && styles.sectionIndicatorActive]} />
              </Pressable>
            );
          })}
        </View>
      ) : (
        <View style={styles.flex} />
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${online ? 'Online' : 'Offline'}, ${pending} unsent`}
        disabled={!showSections}
        onPress={() => goToSection('SyncStatus')}
        style={[styles.status, { backgroundColor: statusTone.bg }]}
      >
        <View style={[styles.dot, { backgroundColor: statusTone.fg }]} />
        <Text style={[styles.statusText, { color: statusTone.fg }]}>
          {online ? 'Online' : 'Offline'}
          {pending > 0 ? ` · ${pending} unsent` : syncing ? ' · checking in' : ''}
          {rejected > 0 ? ` · ${rejected} rejected` : ''}
        </Text>
      </Pressable>

      {signedIn && cashier ? (
        <View style={styles.cashier}>
          <Text style={styles.cashierName} numberOfLines={1}>
            Cashier: {cashier.name}
            {pinMode ? ' (PIN)' : ''}
          </Text>
          <Button title="Lock" variant="secondary" compact accessibilityLabel="Lock the till" onPress={() => cashierSession.lock()} />
        </View>
      ) : null}
    </View>
  );
}

function BlockingBanner({ signedIn, attendanceOnly = false }: { signedIn: boolean; attendanceOnly?: boolean }) {
  const styles = useStyles();
  const revoked = useSyncStatus((s) => s.revoked);
  const updateRequired = useSyncStatus((s) => s.updateRequired);
  const blockedReason = useSyncStatus((s) => s.blockedReason);
  const subscriptionLocked = useSyncStatus((s) => s.subscriptionLocked);
  const licenseExpired = useSyncStatus((s) => s.license?.code === 'EXPIRED');
  const current = currentRoute.useValue();
  if (!revoked && !updateRequired && !blockedReason) return null;
  // The Sell and Payment screens show the same reason in their own "Selling is paused" banner.
  if (signedIn && (current === 'Sell' || current === 'Payment')) return null;
  // An attendance-only tablet: the Attendance screen says it itself; elsewhere the same reasons, worded for punches.
  if (attendanceOnly) {
    if (current === 'Attendance') return null;
    const reason = revoked || updateRequired || subscriptionLocked || licenseExpired;
    if (!reason) return null;
    return (
      <Banner
        kind="danger"
        title={revoked ? 'Device revoked — attendance stopped' : updateRequired ? 'App update required' : subscriptionLocked ? 'Subscription locked — attendance stopped' : 'License expired — attendance stopped'}
        message={revoked ? 'This device was revoked on the server. Go to Settings → Re-enroll to enroll it again.' : (blockedReason ?? 'Connect to the internet and let the device check in.')}
        actionLabel={revoked ? 'Settings' : 'Check-in'}
        onAction={() => goToSection(revoked ? 'Settings' : 'SyncStatus')}
        style={styles.blocking}
      />
    );
  }
  const title = revoked
    ? 'Device revoked — selling stopped'
    : updateRequired
      ? 'App update required — selling stopped'
      : subscriptionLocked
        ? 'Subscription locked — selling stopped'
        : licenseExpired
          ? 'License expired — selling stopped'
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
      actionLabel={signedIn ? (revoked ? 'Settings' : 'Check-in') : undefined}
      onAction={signedIn ? () => goToSection(target) : undefined}
      style={styles.blocking}
    />
  );
}

/** Non-blocking warnings (license overdue / about to expire, not checked in for N h) — hidden while selling is
 * blocked (the blocking banner says more). */
function WarningBanner({ signedIn }: { signedIn: boolean }) {
  const styles = useStyles();
  const blocked = useSyncStatus((s) => s.revoked || !!s.updateRequired || !!s.blockedReason);
  const licenseWarning = useSyncStatus((s) => s.licenseWarning);
  const offlineWarning = useSyncStatus((s) => s.offlineWarning);
  if (blocked || (!licenseWarning && !offlineWarning)) return null;
  const message = [licenseWarning, offlineWarning].filter(Boolean).join('\n');
  return (
    <Banner
      kind="warning"
      message={message}
      actionLabel={signedIn ? 'Check-in' : undefined}
      onAction={signedIn ? () => goToSection('SyncStatus') : undefined}
      style={styles.blocking}
    />
  );
}

const useStyles = makeStyles((colors, type) => ({
  fontWait: { flex: 1, backgroundColor: colors.background },
  // The status-bar strip above the brand header is the brand primary too (status-bar icons follow its contrast).
  frame: { flex: 1, backgroundColor: colors.primary },
  body: { flex: 1, backgroundColor: colors.background },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, padding: spacing.xl },
  loadingText: { ...type.body, marginTop: spacing.md, color: colors.muted },
  errorBanner: { marginBottom: spacing.lg, alignSelf: 'stretch' },
  flex: { flex: 1 },
  // Solid brand-primary bar (the web's sidebar, turned sideways): on-primary text, accent tab indicator.
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    minHeight: 64,
    gap: spacing.lg,
  },
  topLeft: { maxWidth: 340, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  topLeftText: { flexShrink: 1 },
  logoChip: {
    backgroundColor: '#ffffff',
    borderRadius: radius.sm,
    paddingHorizontal: spacing.xs + 2,
    paddingVertical: spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: { width: 72, height: 32 },
  brand: { ...type.overline, fontSize: 11, color: colors.onPrimaryMuted },
  terminal: { ...type.heading, color: colors.onPrimary },
  // Sections are tabs: muted white label, white label + 3px accent indicator when selected.
  sections: { flex: 1, flexDirection: 'row', alignSelf: 'stretch', gap: spacing.xs },
  section: { paddingHorizontal: spacing.lg, justifyContent: 'center', alignItems: 'center', minHeight: 48 },
  sectionPressed: { backgroundColor: colors.onPrimaryPressed },
  sectionText: { ...type.button, color: colors.onPrimaryMuted, flex: 1, textAlignVertical: 'center', paddingTop: 2 },
  sectionTextActive: { color: colors.onPrimary, fontFamily: type.bodyStrong.fontFamily },
  sectionIndicator: { alignSelf: 'stretch', height: 3, backgroundColor: 'transparent' },
  sectionIndicatorActive: { backgroundColor: colors.accent },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.pill,
  },
  dot: { width: 8, height: 8, borderRadius: radius.pill },
  statusText: { ...type.caption, fontFamily: type.bodyStrong.fontFamily },
  cashier: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, maxWidth: 300 },
  cashierName: { ...type.subtitle, flexShrink: 1, color: colors.onPrimary },
  blocking: { borderRadius: 0 },
  lockNotice: { borderRadius: 0 },
  // Locked-till launcher on an attendance kiosk (LockedHome): two segments under the top bar.
  launcher: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  launcherTab: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.primary },
  launcherTabActive: { backgroundColor: colors.primary },
  launcherText: { ...type.button, color: colors.primary },
  launcherTextActive: { color: colors.onPrimary },
  previewStrip: {
    backgroundColor: colors.warningSoft,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs + 2,
  },
  previewStripText: { ...type.caption, color: colors.text, textAlign: 'center' },
  previewStripTitle: { fontFamily: type.bodyStrong.fontFamily, color: colors.warning },
}));
