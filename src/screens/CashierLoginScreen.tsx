// Cashier sign-in: online (email + password, + the authenticator code when the server asks for it) or offline PIN
// unlock (pick a cashier who has set a PIN on this device). After an online sign-in without a PIN on this device, the
// cashier must choose one before the till opens (also reachable later via Settings → Change offline PIN).
import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, Text, View, type TextInput } from 'react-native';

import {
  cashierSession,
  PIN_MAX_LENGTH,
  PIN_MIN_LENGTH,
  PinLockedError,
  pinProblem,
  useCashier,
} from '../auth/cashierSession';
import { errorMessage } from '../components/shell/format';
import { localStore } from '../db/localStore';
import { useSyncStatus } from '../sync/syncEngine';
import { Banner, Button, TextField } from '../ui/components';
import { makeStyles } from '../ui/brandTheme';
import { radius, shadow, spacing } from '../ui/theme';

export interface CashierLoginScreenProps {
  terminalLabel?: string | null;
}

export function CashierLoginScreen({ terminalLabel }: CashierLoginScreenProps) {
  const styles = useStyles();
  const pinSetupRequired = useCashier((s) => s.pinSetupRequired);
  return (
    <KeyboardAvoidingView behavior="height" style={styles.root}>
      <ScrollView contentContainerStyle={styles.center} keyboardShouldPersistTaps="handled">
        <View style={styles.panel}>
          <View style={styles.strip} />
          <View style={styles.panelBody}>
            <View style={styles.header}>
              <Text style={styles.brand}>GamotERP POS</Text>
              {terminalLabel ? <Text style={styles.terminal}>{terminalLabel}</Text> : null}
            </View>
            {pinSetupRequired ? <PinSetup /> : <SignIn />}
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ---- Sign in / unlock --------------------------------------------------------------------------------------------

function SignIn() {
  const styles = useStyles();
  const online = useSyncStatus((s) => s.online);
  const locked = useCashier((s) => s.locked);
  const [pinUsers, setPinUsers] = useState<{ userId: number; name: string }[] | null>(null);
  const [mode, setMode] = useState<'PIN' | 'PASSWORD'>('PASSWORD');

  useEffect(() => {
    localStore
      .listPinUsers()
      .then((list) => {
        setPinUsers(list);
        // Default to PIN unlock when anyone can use it (always when offline — a password sign-in needs the server).
        if (list.length > 0 && (!online || locked)) setMode('PIN');
      })
      .catch(() => setPinUsers([]));
    // Decide the default tab once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasPinUsers = (pinUsers?.length ?? 0) > 0;
  return (
    <>
      <View style={styles.tabs}>
        <Tab label="Sign in with password" active={mode === 'PASSWORD'} onPress={() => setMode('PASSWORD')} />
        <Tab label="Unlock with PIN" active={mode === 'PIN'} onPress={() => setMode('PIN')} disabled={!hasPinUsers} />
      </View>
      {mode === 'PASSWORD' ? (
        <PasswordForm online={online} hasPinUsers={hasPinUsers} />
      ) : (
        <PinUnlock users={pinUsers ?? []} preselect={locked?.cashier.userId ?? null} />
      )}
    </>
  );
}

function Tab({ label, active, onPress, disabled }: { label: string; active: boolean; onPress: () => void; disabled?: boolean }) {
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.tab, active && styles.tabActive, disabled && styles.tabDisabled]}
    >
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

function PasswordForm({ online, hasPinUsers }: { online: boolean; hasPinUsers: boolean }) {
  const styles = useStyles();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<TextInput>(null);

  const submit = async () => {
    setError(null);
    if (!email.trim() || !password) return setError('Enter your email and password.');
    if (mfaRequired && !/^\d{6}$/.test(mfaCode)) return setError('Enter the 6-digit code from your authenticator app.');
    setBusy(true);
    try {
      const r = await cashierSession.loginOnline(email, password, mfaRequired ? mfaCode : undefined);
      if (r === 'MFA_REQUIRED') {
        setMfaRequired(true);
        setMfaCode('');
      }
      // 'OK' → the shell re-renders (PIN setup or the till).
    } catch (e) {
      setError(errorMessage(e, 'Sign-in failed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      {!online ? (
        <Banner
          kind="warning"
          title="Offline"
          message={hasPinUsers ? 'Signing in with a password needs a connection. Unlock with your PIN instead.' : 'Signing in needs a connection the first time on this device.'}
          style={styles.gap}
        />
      ) : null}
      <TextField
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        autoComplete="email"
        returnKeyType="next"
        onSubmitEditing={() => passwordRef.current?.focus()}
        editable={!busy && !mfaRequired}
      />
      <TextField
        ref={passwordRef}
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="password"
        returnKeyType="go"
        onSubmitEditing={submit}
        editable={!busy && !mfaRequired}
      />
      {mfaRequired ? (
        <TextField
          label="Authenticator code"
          value={mfaCode}
          onChangeText={(t) => setMfaCode(t.replace(/\D/g, '').slice(0, 6))}
          keyboardType="number-pad"
          maxLength={6}
          autoFocus
          hint="Open your authenticator app and enter the 6-digit code for GamotERP."
          editable={!busy}
          onSubmitEditing={submit}
        />
      ) : null}
      {error ? <Banner kind="danger" message={error} style={styles.gap} /> : null}
      <Button title={mfaRequired ? 'Verify and sign in' : 'Sign in'} onPress={submit} loading={busy} />
      {mfaRequired ? (
        <Button
          title="Use a different account"
          variant="ghost"
          onPress={() => {
            setMfaRequired(false);
            setMfaCode('');
            setPassword('');
            setError(null);
          }}
          disabled={busy}
          style={styles.gapTop}
        />
      ) : null}
    </View>
  );
}

function PinUnlock({ users, preselect }: { users: { userId: number; name: string }[]; preselect: number | null }) {
  const styles = useStyles();
  const [userId, setUserId] = useState<number | null>(
    preselect !== null && users.some((u) => u.userId === preselect) ? preselect : users.length === 1 ? users[0].userId : null,
  );
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedMs, setLockedMs] = useState(0);

  const refreshStatus = useCallback(async (id: number) => {
    const s = await cashierSession.pinStatus(id).catch(() => ({ lockedMs: 0, attemptsLeft: 5 }));
    setLockedMs(s.lockedMs);
    return s;
  }, []);

  useEffect(() => {
    setError(null);
    setPin('');
    if (userId !== null) refreshStatus(userId);
  }, [userId, refreshStatus]);

  // Count the lockout down on screen.
  useEffect(() => {
    if (lockedMs <= 0) return;
    const t = setTimeout(() => setLockedMs((ms) => Math.max(0, ms - 1000)), 1000);
    return () => clearTimeout(t);
  }, [lockedMs]);

  const submit = async () => {
    if (userId === null) return setError('Choose your name.');
    if (pin.length < PIN_MIN_LENGTH) return setError(`Enter your ${PIN_MIN_LENGTH}–${PIN_MAX_LENGTH} digit PIN.`);
    setBusy(true);
    setError(null);
    try {
      const ok = await cashierSession.unlockOffline(userId, pin);
      if (!ok) {
        setPin('');
        const s = await refreshStatus(userId);
        setError(s.lockedMs > 0 ? 'Too many wrong PINs.' : `Wrong PIN. ${s.attemptsLeft} attempt(s) left before a 5-minute lock.`);
      }
    } catch (e) {
      setPin('');
      if (e instanceof PinLockedError) setLockedMs(e.remainingMs);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const lockedText =
    lockedMs > 0 ? `PIN locked. Try again in ${Math.floor(lockedMs / 60000)}:${String(Math.floor((lockedMs % 60000) / 1000)).padStart(2, '0')}, or sign in with your password.` : null;

  return (
    <View>
      <Text style={styles.label}>Who are you?</Text>
      <View style={styles.chips}>
        {users.map((u) => (
          <Pressable
            key={u.userId}
            accessibilityRole="radio"
            accessibilityState={{ selected: u.userId === userId }}
            onPress={() => setUserId(u.userId)}
            style={[styles.chip, u.userId === userId && styles.chipSelected]}
          >
            <Text style={[styles.chipText, u.userId === userId && styles.chipTextSelected]}>{u.name}</Text>
          </Pressable>
        ))}
      </View>
      <TextField
        label="PIN"
        value={pin}
        onChangeText={(t) => setPin(t.replace(/\D/g, '').slice(0, PIN_MAX_LENGTH))}
        keyboardType="number-pad"
        secureTextEntry
        maxLength={PIN_MAX_LENGTH}
        editable={!busy && lockedMs <= 0 && userId !== null}
        onSubmitEditing={submit}
        style={styles.pinInput}
      />
      {lockedText ? <Banner kind="danger" message={lockedText} style={styles.gap} /> : error ? <Banner kind="danger" message={error} style={styles.gap} /> : null}
      <Button title="Unlock" onPress={submit} loading={busy} disabled={userId === null || lockedMs > 0} />
      {busy ? <Text style={styles.hint}>Checking PIN…</Text> : null}
    </View>
  );
}

// ---- Choose an offline PIN ---------------------------------------------------------------------------------------

function PinSetup() {
  const styles = useStyles();
  const cashier = useCashier((s) => s.cashier);
  const optional = useCashier((s) => s.pinChangeOptional);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const problem = pinProblem(pin);
    if (problem) return setError(problem);
    if (pin !== confirm) return setError('The two PINs don’t match.');
    setBusy(true);
    setError(null);
    try {
      await cashierSession.setOfflinePin(pin);
    } catch (e) {
      setError(errorMessage(e, 'Could not save the PIN.'));
    } finally {
      setBusy(false);
    }
  };

  const clean = (t: string) => t.replace(/\D/g, '').slice(0, PIN_MAX_LENGTH);
  return (
    <View>
      <Text style={styles.sectionTitle}>{optional ? 'Change your offline PIN' : 'Set your offline PIN'}</Text>
      <Text style={styles.body}>
        {cashier ? `${cashier.name}, choose` : 'Choose'} a {PIN_MIN_LENGTH}–{PIN_MAX_LENGTH} digit PIN. It unlocks the till on this device
        when there is no connection. Keep it to yourself — sales are recorded under your name.
      </Text>
      <TextField
        label="New PIN"
        value={pin}
        onChangeText={(t) => setPin(clean(t))}
        keyboardType="number-pad"
        secureTextEntry
        maxLength={PIN_MAX_LENGTH}
        editable={!busy}
        autoFocus
        style={styles.pinInput}
      />
      <TextField
        label="Repeat the PIN"
        value={confirm}
        onChangeText={(t) => setConfirm(clean(t))}
        keyboardType="number-pad"
        secureTextEntry
        maxLength={PIN_MAX_LENGTH}
        editable={!busy}
        onSubmitEditing={submit}
        style={styles.pinInput}
      />
      {error ? <Banner kind="danger" message={error} style={styles.gap} /> : null}
      <Button title="Save PIN" onPress={submit} loading={busy} />
      <Button
        title={optional ? 'Cancel' : 'Sign out'}
        variant="ghost"
        onPress={() => (optional ? cashierSession.cancelPinChange() : cashierSession.logout())}
        disabled={busy}
        style={styles.gapTop}
      />
    </View>
  );
}

const useStyles = makeStyles((c, t) => ({
  root: { flex: 1, backgroundColor: c.background },
  center: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
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
  strip: { height: 6, backgroundColor: c.primary },
  panelBody: { padding: spacing.xxl },
  header: { alignItems: 'center', marginBottom: spacing.xl },
  brand: { ...t.display, color: c.primary, textAlign: 'center' },
  terminal: { ...t.label, color: c.muted, textAlign: 'center', marginTop: spacing.xs },
  sectionTitle: { ...t.heading, marginBottom: spacing.sm },
  tabs: {
    flexDirection: 'row',
    marginBottom: spacing.xl,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.borderStrong,
    overflow: 'hidden',
  },
  tab: {
    flex: 1,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.surface,
  },
  tabActive: { backgroundColor: c.primarySoft },
  tabDisabled: { opacity: 0.5 },
  tabText: { ...t.button, color: c.muted, textAlign: 'center' },
  tabTextActive: { color: c.primary },
  gap: { marginBottom: spacing.md },
  gapTop: { marginTop: spacing.sm },
  label: { ...t.label, marginBottom: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.lg },
  chip: {
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.borderStrong,
    backgroundColor: c.surface,
  },
  chipSelected: { backgroundColor: c.primarySoft, borderColor: c.primary },
  chipText: { ...t.body },
  chipTextSelected: { ...t.bodyStrong, color: c.primary },
  pinInput: { ...t.title, letterSpacing: 8, textAlign: 'center' },
  hint: { ...t.caption, textAlign: 'center', marginTop: spacing.sm },
  body: { ...t.body, color: c.muted, marginBottom: spacing.lg },
}));
