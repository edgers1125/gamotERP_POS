// Module boundaries of the GamotERP POS app (plan: ../GamotERP/docs/plans/pos-android-app.md). Each package implements
// the module(s) it owns EXACTLY to these interfaces, exporting a const with the listed name from the listed file, so
// packages can be built in parallel. Types from the backend contract are re-used, never redefined.
import type {
  CashierSessionResponse,
  EnrollChallengeResponse,
  EnrollResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  PosApprovalKind,
  PosApprover,
  PosBootstrap,
  PosCatalog,
  PosClient,
  PosCounters,
  PosRefundRequest,
  PosRefundResponse,
  PosSaleRow,
  PosStockRow,
  PublicJwkEC,
  SalePayload,
  SyncOp,
  SyncOpResult,
  SyncResponse,
  VoidPayload,
} from '@pos-api/contract';

// ============================== P-A1: device key, JOSE, API client, enrollment ==============================

// src/device/deviceKey.ts → `export const deviceKey: DeviceKey`
// Backed by the local Expo module modules/pos-device (Kotlin): an EC P-256 key in the Android Keystore (StrongBox when
// available), non-exportable, created with setAttestationChallenge(challenge).
export interface DeviceKey {
  hasKey(): Promise<boolean>;
  /** Creates (replacing any old one) the device key bound to the enrollment challenge; returns the public key and the
   * attestation chain (leaf first, base64 DER). */
  createKey(challengeBase64Url: string): Promise<{ publicJwk: PublicJwkEC; attestationChain: string[] }>;
  publicJwk(): Promise<PublicJwkEC>;
  /** RFC 7638 thumbprint of the public key (base64url). */
  thumbprint(): Promise<string>;
  /** ES256 signature (JOSE raw r||s, base64url) over the UTF-8 bytes of `signingInput`. */
  sign(signingInput: string): Promise<string>;
  deleteKey(): Promise<void>;
  /** Play Integrity standard token for requestHash (base64url) — null when unavailable/not configured. */
  integrityToken(requestHash: string, cloudProjectNumber: string): Promise<string | null>;
  /** Device facts for enrollment. */
  deviceInfo(): Promise<{ model: string | null; serial: string | null; androidSdk: number | null; strongBox: boolean }>;
}

// src/device/jose.ts → `export const jose: Jose`
export interface Jose {
  /** DPoP proof JWT for one request (contract "AUTH"). */
  dpopProof(method: string, url: string, accessToken?: string): Promise<string>;
  /** Compact JWS over canonicalJson(payload) (contract SyncOp.signature). */
  signOpPayload(payload: SalePayload | VoidPayload): Promise<string>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string | null = null,
    public fieldErrors: Record<string, string[]> | null = null,
  ) {
    super(message);
  }
  /** Network failure / timeout (status 0) — the caller should treat the device as offline. */
  get isNetwork() {
    return this.status === 0;
  }
}

// src/api/client.ts → `export const api: PosApi`
// Adds DPoP + the cached device access token (re-fetched on expiry/401) to every device call, and the cashier token
// (from `cashierSession`, P-A4) to cashier calls. Throws ApiError. Base URL from `serverConfig`.
export interface PosApi {
  enrollChallenge(code: string): Promise<EnrollChallengeResponse>;
  enroll(input: { code: string; challenge: EnrollChallengeResponse }): Promise<EnrollResponse>; // does createKey + integrity + POST
  cashierSession(email: string, password: string, mfaCode?: string): Promise<CashierSessionResponse>;
  bootstrap(): Promise<PosBootstrap>;
  catalog(): Promise<PosCatalog>;
  clients(search: string): Promise<PosClient[]>;
  approvers(kind: PosApprovalKind): Promise<PosApprover[]>;
  stock(skuIds: number[]): Promise<PosStockRow[]>;
  sales(date?: string): Promise<PosSaleRow[]>;
  sync(ops: SyncOp[]): Promise<SyncResponse>;
  refund(input: PosRefundRequest): Promise<PosRefundResponse>;
  heartbeat(input: HeartbeatRequest): Promise<HeartbeatResponse>;
}

// src/config/serverConfig.ts → `export const serverConfig: ServerConfig` (expo-secure-store)
export interface ServerConfig {
  getBaseUrl(): Promise<string | null>; // e.g. "http://10.0.2.2:4001/api"
  setBaseUrl(url: string): Promise<void>;
}

// ============================== P-A2: local encrypted DB, outbox, counters, sync ==============================

export interface EnrollmentState {
  device_id: number;
  terminal: EnrollResponse['terminal'];
  enrolled_at: string;
}

export interface LocalSale {
  client_uuid: string;
  invoice_number: string; // formatted (formatInvoiceNumber)
  payload: SalePayload;
  sync_status: 'PENDING' | 'RECORDED' | 'REJECTED';
  sync_result: SyncOpResult | null;
  voided: { voided_at: string; reason: string; sync_status: 'PENDING' | 'RECORDED' | 'REJECTED' } | null;
  refunded: boolean;
}

// src/db/localStore.ts → `export const localStore: LocalStore`
// op-sqlite with SQLCipher; the DB key is random, kept in expo-secure-store. EVERY write that assigns an invoice
// number does it in ONE SQL transaction together with saving the sale and enqueuing its signed op — a crash can
// never leave a printed number unsaved, reused or skipped.
export interface LocalStore {
  init(): Promise<void>;
  // enrollment / bootstrap / catalog caches
  getEnrollment(): Promise<EnrollmentState | null>;
  saveEnrollment(e: EnrollmentState, counters: PosCounters): Promise<void>; // also sets the device-owned counters
  clearEnrollment(): Promise<void>;
  getBootstrap(): Promise<PosBootstrap | null>;
  saveBootstrap(b: PosBootstrap): Promise<void>;
  getCatalog(): Promise<PosCatalog | null>;
  saveCatalog(c: PosCatalog): Promise<void>;
  getApprovers(kind: PosApprovalKind): Promise<PosApprover[]>;
  saveApprovers(kind: PosApprovalKind, list: PosApprover[]): Promise<void>;
  // counters (device-owned)
  getCounters(): Promise<PosCounters>;
  /** Atomically: take the next invoice seq, build the payload with it, sign (jose.signOpPayload), save the sale and
   * enqueue the SALE op. `build` receives the seq and returns the full SalePayload. */
  recordSale(build: (invoiceSeq: number) => SalePayload): Promise<LocalSale>;
  /** Enqueue a VOID op for a local sale (same business day — the caller checks). */
  recordVoid(saleUuid: string, payload: VoidPayload): Promise<void>;
  /** Take the next return seq (for an online refund) — only committed via commitReturnSeq after the server accepted. */
  peekReturnSeq(): Promise<number>;
  commitReturnSeq(used: number): Promise<void>;
  listSales(businessDate: string): Promise<LocalSale[]>;
  getSale(clientUuid: string): Promise<LocalSale | null>;
  // outbox
  pendingOps(limit: number): Promise<SyncOp[]>; // oldest first
  pendingCount(): Promise<{ count: number; oldestAt: string | null; offlineSales: number }>;
  applyResults(results: SyncOpResult[]): Promise<void>;
  rejectedOps(): Promise<{ op: SyncOp; result: SyncOpResult }[]>;
  // offline cashier PINs (P-A4 uses these): salted hash only, never the PIN
  savePinVerifier(userId: number, name: string, email: string, permissions: string[], verifier: string): Promise<void>;
  getPinVerifier(userId: number): Promise<{ userId: number; name: string; email: string; permissions: string[]; verifier: string } | null>;
  listPinUsers(): Promise<{ userId: number; name: string }[]>;
}

export interface SyncStatus {
  online: boolean;
  syncing: boolean;
  pending: number;
  oldestPendingAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  rejected: number;
  revoked: boolean;
  updateRequired: string | null; // min_app_version when this app is too old
  /** Non-null → selling is blocked (offline limits reached, revoked, update required). */
  blockedReason: string | null;
}

// src/sync/syncEngine.ts → `export const syncEngine: SyncEngine` and `export const useSyncStatus` (zustand hook)
// Syncs every few seconds while online (NetInfo), heartbeats every ~60 s, refreshes bootstrap/catalog when the
// server's catalog_version changes, enforces the terminal's offline limits.
export interface SyncEngine {
  start(): void;
  stop(): void;
  syncNow(): Promise<void>;
  refreshCatalog(force?: boolean): Promise<void>;
}

// ============================== P-A3: selling ==============================
// src/sale/cart.ts (zustand store `useCart`), src/sale/totals.ts (wraps @shared/material-issuance-pricing),
// src/screens/SellScreen.tsx, PaymentScreen.tsx, ReceiptScreen.tsx, components in src/components/sale/*,
// src/printer/printer.ts → `export const printer: ReceiptPrinter`.
export interface ReceiptPrinter {
  isAvailable(): Promise<boolean>;
  printText(lines: string[]): Promise<void>; // ESC/POS text lines; the on-screen receipt is always shown too
}

// ============================== P-A4: cashier auth, shell, other screens ==============================
// src/auth/cashierSession.ts → `export const cashierSession: CashierSessionStore` + `export const useCashier` (zustand)
export interface CashierState {
  userId: number;
  name: string;
  email: string;
  permissions: string[];
  mode: 'ONLINE' | 'OFFLINE_PIN'; // OFFLINE_PIN → no server token; cashier calls unavailable
  token: string | null;
}
export interface CashierSessionStore {
  current(): CashierState | null;
  tokenForApi(): string | null;
  loginOnline(email: string, password: string, mfaCode?: string): Promise<'OK' | 'MFA_REQUIRED'>;
  setOfflinePin(pin: string): Promise<void>; // after an online login
  unlockOffline(userId: number, pin: string): Promise<boolean>;
  logout(): void;
}
// App.tsx (navigation shell), src/screens/CashierLoginScreen.tsx, SalesTodayScreen.tsx, VoidDialog, RefundScreen.tsx,
// SyncStatusScreen.tsx, SettingsScreen.tsx.
