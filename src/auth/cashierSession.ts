// Cashier sign-in on this device (plan "Security model" 3, contract POST /pos/session).
//
// * Online: email + password (+ the 6-digit MFA code when the server asks for one) → a cashier token bound to this
//   device's key and terminal. Kept in memory only (never persisted) — a restarted app signs in again or unlocks with
//   the offline PIN.
// * After an online sign-in, a cashier who has no offline PIN on this device must set one (4–6 digits). Only a salted
//   PBKDF2-HMAC-SHA256 verifier is stored (`localStore.savePinVerifier`, inside the SQLCipher DB) — never the PIN.
//   A cashier who already has one gets their name/permissions snapshot refreshed and may change the PIN later.
// * Offline: pick a cashier who has a PIN on this device + the PIN → OFFLINE_PIN mode (no token; cashier-only server
//   calls are unavailable). 5 wrong PINs lock that cashier's PIN for 5 minutes; the lock is kept in the Keystore-backed
//   secure store so restarting the app doesn't reset it.
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

import { api } from '../api/client';
import type { CashierSessionStore, CashierState } from '../contracts';
import { localStore } from '../db/localStore';
import { fromBase64, pbkdf2Sha256, timingSafeEqual, toBase64, utf8 } from './pbkdf2';

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 6;
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCKOUT_MS = 5 * 60 * 1000;
// Two SHA-256 compressions per iteration in JS; ~1–2 s on a low-end Hermes device. Stored in each verifier, so it can
// be raised later without invalidating existing PINs.
const PIN_ITERATIONS = 20000;
const VERIFIER_SCHEME = 'pbkdf2-sha256';

interface CashierStore {
  cashier: CashierState | null;
  /** When the online cashier token expires (epoch ms); null in OFFLINE_PIN mode. */
  tokenExpiresAt: number | null;
  /** Online sign-in done but this cashier must (re)set an offline PIN before the till opens. */
  pinSetupRequired: boolean;
  /** True when pinSetupRequired was triggered by "Change PIN" (a PIN already exists, so it can be cancelled). */
  pinChangeOptional: boolean;
  /** An ONLINE session put aside by lock(): unlocking with the same cashier's PIN restores it while the token lasts. */
  locked: { cashier: CashierState; tokenExpiresAt: number | null } | null;
}

export const useCashier = create<CashierStore>(() => ({
  cashier: null,
  tokenExpiresAt: null,
  pinSetupRequired: false,
  pinChangeOptional: false,
  locked: null,
}));

// ---- PIN rules + verifier ------------------------------------------------------------------------------------------

/** User-facing reason a PIN is refused, or null when acceptable. */
export function pinProblem(pin: string): string | null {
  if (!/^\d+$/.test(pin)) return 'The PIN must contain digits only.';
  if (pin.length < PIN_MIN_LENGTH || pin.length > PIN_MAX_LENGTH) {
    return `The PIN must be ${PIN_MIN_LENGTH} to ${PIN_MAX_LENGTH} digits.`;
  }
  if (/^(\d)\1+$/.test(pin)) return 'Choose a PIN that is not the same digit repeated.';
  const digits = pin.split('').map(Number);
  const ascending = digits.every((d, i) => i === 0 || d === (digits[i - 1] + 1) % 10);
  const descending = digits.every((d, i) => i === 0 || d === (digits[i - 1] + 9) % 10);
  if (ascending || descending) return 'Choose a PIN that is not a simple sequence like 1234.';
  return null;
}

async function makeVerifier(pin: string): Promise<string> {
  const salt = Crypto.getRandomBytes(16);
  const hash = await pbkdf2Sha256(utf8(pin), salt, PIN_ITERATIONS, 32);
  return `${VERIFIER_SCHEME}$${PIN_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

async function checkVerifier(pin: string, verifier: string): Promise<boolean> {
  const parts = verifier.split('$');
  if (parts.length !== 4 || parts[0] !== VERIFIER_SCHEME) return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) return false;
  const salt = fromBase64(parts[2]);
  const expected = fromBase64(parts[3]);
  const actual = await pbkdf2Sha256(utf8(pin), salt, iterations, expected.length);
  return timingSafeEqual(actual, expected);
}

// ---- Lockout (per cashier, persisted) ------------------------------------------------------------------------------

interface LockoutState {
  failures: number;
  lockedAt: number | null;
  lockedUntil: number | null;
}

const lockoutKey = (userId: number) => `pos.pinlock.${userId}`;

async function readLockout(userId: number): Promise<LockoutState> {
  try {
    const raw = await SecureStore.getItemAsync(lockoutKey(userId));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LockoutState>;
      return {
        failures: typeof parsed.failures === 'number' ? parsed.failures : 0,
        lockedAt: typeof parsed.lockedAt === 'number' ? parsed.lockedAt : null,
        lockedUntil: typeof parsed.lockedUntil === 'number' ? parsed.lockedUntil : null,
      };
    }
  } catch {
    // Unreadable → treat as no failures recorded (the verifier still has to match).
  }
  return { failures: 0, lockedAt: null, lockedUntil: null };
}

async function writeLockout(userId: number, s: LockoutState): Promise<void> {
  if (s.failures === 0 && s.lockedUntil === null) {
    await SecureStore.deleteItemAsync(lockoutKey(userId)).catch(() => undefined);
  } else {
    await SecureStore.setItemAsync(lockoutKey(userId), JSON.stringify(s));
  }
}

/** Remaining lockout in ms (0 = not locked). A clock moved backwards restarts the lock instead of ending it. */
async function activeLockout(userId: number): Promise<{ remainingMs: number; failures: number }> {
  const s = await readLockout(userId);
  const now = Date.now();
  if (s.lockedUntil !== null) {
    if (s.lockedAt !== null && now < s.lockedAt) {
      await writeLockout(userId, { failures: 0, lockedAt: now, lockedUntil: now + PIN_LOCKOUT_MS });
      return { remainingMs: PIN_LOCKOUT_MS, failures: 0 };
    }
    if (now < s.lockedUntil) return { remainingMs: s.lockedUntil - now, failures: s.failures };
    await writeLockout(userId, { failures: 0, lockedAt: null, lockedUntil: null });
    return { remainingMs: 0, failures: 0 };
  }
  return { remainingMs: 0, failures: s.failures };
}

// ---- The store ----------------------------------------------------------------------------------------------------

export class PinLockedError extends Error {
  constructor(public remainingMs: number) {
    super(`Too many wrong PINs. Try again in ${Math.ceil(remainingMs / 60000)} minute(s).`);
  }
}

export interface CashierSessionExtras {
  /** The token's still-valid online session (ONLINE mode with an unexpired token). */
  isOnlineSession(): boolean;
  /** Lock the till: the cashier must sign in or unlock with a PIN again (the same cashier's PIN resumes an online
   * session whose token hasn't expired). */
  lock(): void;
  /** Ask the signed-in ONLINE cashier to choose a new offline PIN (cancellable). */
  requestPinChange(): void;
  cancelPinChange(): void;
  /** Lockout status of one cashier's PIN on this device. */
  pinStatus(userId: number): Promise<{ lockedMs: number; attemptsLeft: number }>;
}

function tokenValid(): boolean {
  const { cashier, tokenExpiresAt } = useCashier.getState();
  return !!cashier && cashier.mode === 'ONLINE' && !!cashier.token && tokenExpiresAt !== null && Date.now() < tokenExpiresAt;
}

export const cashierSession: CashierSessionStore & CashierSessionExtras = {
  current() {
    return useCashier.getState().cashier;
  },

  tokenForApi() {
    return tokenValid() ? useCashier.getState().cashier!.token : null;
  },

  isOnlineSession() {
    return tokenValid();
  },

  async loginOnline(email, password, mfaCode) {
    const res = await api.cashierSession(email.trim(), password, mfaCode?.trim() || undefined);
    if (res.mfa_required) return 'MFA_REQUIRED';
    const cashier: CashierState = {
      userId: res.user.id,
      name: res.user.name,
      email: res.user.email,
      permissions: res.permissions,
      mode: 'ONLINE',
      token: res.cashier_token,
    };
    // Keep the offline snapshot (name/permissions) fresh when this cashier already has a PIN here.
    const existing = await localStore.getPinVerifier(cashier.userId);
    if (existing) {
      await localStore.savePinVerifier(cashier.userId, cashier.name, cashier.email, cashier.permissions, existing.verifier);
      // A successful password sign-in also clears any PIN lockout for this cashier.
      await writeLockout(cashier.userId, { failures: 0, lockedAt: null, lockedUntil: null }).catch(() => undefined);
    }
    useCashier.setState({
      locked: null,
      cashier,
      tokenExpiresAt: Date.now() + Math.max(0, res.expires_in - 30) * 1000,
      pinSetupRequired: !existing,
      pinChangeOptional: false,
    });
    return 'OK';
  },

  async setOfflinePin(pin) {
    const { cashier } = useCashier.getState();
    if (!cashier || cashier.mode !== 'ONLINE') throw new Error('Sign in with your password first to set an offline PIN.');
    const problem = pinProblem(pin);
    if (problem) throw new Error(problem);
    const verifier = await makeVerifier(pin);
    await localStore.savePinVerifier(cashier.userId, cashier.name, cashier.email, cashier.permissions, verifier);
    await writeLockout(cashier.userId, { failures: 0, lockedAt: null, lockedUntil: null }).catch(() => undefined);
    useCashier.setState({ pinSetupRequired: false, pinChangeOptional: false });
  },

  async unlockOffline(userId, pin) {
    const lock = await activeLockout(userId);
    if (lock.remainingMs > 0) throw new PinLockedError(lock.remainingMs);
    const stored = await localStore.getPinVerifier(userId);
    const ok = !!stored && /^\d{4,6}$/.test(pin) && (await checkVerifier(pin, stored.verifier));
    if (!ok) {
      const failures = lock.failures + 1;
      if (failures >= PIN_MAX_FAILURES) {
        const now = Date.now();
        await writeLockout(userId, { failures, lockedAt: now, lockedUntil: now + PIN_LOCKOUT_MS });
      } else {
        await writeLockout(userId, { failures, lockedAt: null, lockedUntil: null });
      }
      return false;
    }
    await writeLockout(userId, { failures: 0, lockedAt: null, lockedUntil: null }).catch(() => undefined);
    const { locked } = useCashier.getState();
    if (locked && locked.cashier.userId === userId && locked.tokenExpiresAt !== null && Date.now() < locked.tokenExpiresAt) {
      // The same cashier unlocking a till they locked: resume their online session.
      useCashier.setState({ cashier: locked.cashier, tokenExpiresAt: locked.tokenExpiresAt, locked: null });
      return true;
    }
    useCashier.setState({
      locked: null,
      cashier: {
        userId: stored.userId,
        name: stored.name,
        email: stored.email,
        permissions: stored.permissions,
        mode: 'OFFLINE_PIN',
        token: null,
      },
      tokenExpiresAt: null,
      pinSetupRequired: false,
      pinChangeOptional: false,
    });
    return true;
  },

  async pinStatus(userId) {
    const lock = await activeLockout(userId);
    return { lockedMs: lock.remainingMs, attemptsLeft: Math.max(0, PIN_MAX_FAILURES - lock.failures) };
  },

  requestPinChange() {
    if (tokenValid()) useCashier.setState({ pinSetupRequired: true, pinChangeOptional: true });
  },

  cancelPinChange() {
    if (useCashier.getState().pinChangeOptional) useCashier.setState({ pinSetupRequired: false, pinChangeOptional: false });
  },

  lock() {
    const { cashier, tokenExpiresAt, pinSetupRequired } = useCashier.getState();
    // A cashier still owing a PIN has nothing to unlock with — locking signs them out instead.
    const keep = cashier && cashier.mode === 'ONLINE' && !pinSetupRequired ? { cashier, tokenExpiresAt } : null;
    useCashier.setState({ cashier: null, tokenExpiresAt: null, pinSetupRequired: false, pinChangeOptional: false, locked: keep });
  },

  logout() {
    useCashier.setState({ cashier: null, tokenExpiresAt: null, pinSetupRequired: false, pinChangeOptional: false, locked: null });
  },
};
