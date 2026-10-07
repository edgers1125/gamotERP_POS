// Module boundaries of the GamotERP POS app (plan: ../GamotERP/apps/pharma/docs/plans/pos-android-app.md). Each package implements
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
  PosDisplayConfig,
  PosDisplayImage,
  PosBrand,
  PosRefundRequest,
  PosRefundResponse,
  PosSaleRow,
  PosStockRow,
  PosAttendanceEmployees,
  PosAttendanceKiosk,
  PosAttendancePunchPayload,
  PosAttendancePunchResult,
  PosAttendanceTicket,
  PublicJwkEC,
  SalePayload,
  SyncOp,
  SyncOpResult,
  SyncResponse,
  VoidPayload,
} from '@pos-api/contract';

import type { LicenseCode } from './license/lease';

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
  /** Compact JWS over canonicalJson(payload) (contract SyncOp.signature) — sale, void and cash-drawer ops alike. */
  signOpPayload(payload: SyncOp['payload']): Promise<string>;
  /** The same compact JWS (header { alg: ES256, typ: pos-op+jws, kid }) over canonicalJson(punch) — an attendance punch
   * (contract "Attendance kiosk mode", POST /pos/attendance/punches field `signature`). */
  signPunchPayload(payload: PosAttendancePunchPayload): Promise<string>;
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
  // Customer display (device auth only, no cashier): config + base64 images. Logo/ad 404 = none.
  display(): Promise<PosDisplayConfig>;
  displayLogo(): Promise<PosDisplayImage>;
  displayAd(id: number): Promise<PosDisplayImage>;
  // The signed-in cashier's brand (device + cashier auth; src/ui/brandSource.ts). Logo 404 = none.
  cashierBrand(): Promise<PosBrand>;
  cashierBrandLogo(): Promise<PosDisplayImage>;
  // The company's receipt logo (Settings → Receipts; device auth). 404 = none. Fetched only when
  // bootstrap.receipt.logo_checksum changes (src/sale/receiptAssets.ts).
  receiptLogo(): Promise<PosDisplayImage>;
}

// src/api/client.ts → `export const attendanceApi: AttendanceApi` — attendance kiosk mode (contract "Attendance kiosk
// mode"; device auth only, NO cashier). 403 ATTENDANCE_KIOSK_OFF = this terminal isn't an attendance kiosk (any call).
export interface AttendanceApi {
  kiosk(): Promise<PosAttendanceKiosk>;
  employees(): Promise<PosAttendanceEmployees>;
  /** Online PIN check → ticket + the server's challenge. ApiError codes WRONG_PIN / PIN_LOCKED / NO_PIN, 404, 429. */
  pin(input: { user_id: number; pin: string; kind: 'IN' | 'OUT' }): Promise<PosAttendanceTicket>;
  /** Multipart upload of one signed punch: `punchText` = the signed canonical JSON, files = frame0..n (file:// URIs).
   * 201 RECORDED / 200 DUPLICATE / 422 REJECTED are all returned as the result body; anything else throws ApiError. */
  punch(input: { punchText: string; signature: string; files: { name: string; uri: string; filename: string }[] }): Promise<PosAttendancePunchResult>;
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
  // per-cashier brand cache (src/ui/brandSource.ts) so an offline PIN unlock is themed with no network; logos are
  // stored once per checksum and pruned when no cached cashier brand uses them any more
  getCashierBrand(userId: number): Promise<PosBrand | null>;
  saveCashierBrand(userId: number, brand: PosBrand): Promise<void>;
  getBrandLogo(checksum: string): Promise<PosDisplayImage | null>;
  saveBrandLogo(checksum: string, image: PosDisplayImage): Promise<void>;
  // Receipt logo cache (one per checksum; saving one drops any other).
  getReceiptLogo(checksum: string): Promise<PosDisplayImage | null>;
  saveReceiptLogo(checksum: string, image: PosDisplayImage): Promise<void>;
  // A sale's receipt snapshot (sales.receipt_json — src/sale/receipt.ts ReceiptSnapshot), JSON text.
  getReceiptSnapshot(clientUuid: string): Promise<string | null>;
  saveReceiptSnapshot(clientUuid: string, json: string): Promise<void>;
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
  /** Non-null → selling is blocked (revoked, update required, subscription locked / license expired, offline limits). */
  blockedReason: string | null;
  /** The subscription is locked (403 SUBSCRIPTION_LOCKED, realtime 4402 or a check-in's license.state LOCKED). */
  subscriptionLocked: boolean;
  /** Non-blocking: "Payment overdue — selling stops on …" / "Check in before … or selling stops" (src/db/policy.ts). */
  licenseWarning: string | null;
  /** Non-blocking: "Not checked in for N h …" (docs/plans/pos-offline-unlimited.md A3). */
  offlineWarning: string | null;
  /** License lease diagnostics for the Check-in screen (src/license/). null until first computed. */
  license: { code: LicenseCode; state: 'OK' | 'OVERDUE' | null; validUntil: string | null; detail: string | null } | null;
  /** Real-time channel (src/sync/realtime.ts): true while the WebSocket is connected (its `state` arrived) — the
   * heartbeat / periodic bootstrap polling is paused meanwhile. */
  live: boolean;
  /** 'connected' | 'reconnecting' (wanted but down — polling meanwhile) | 'off' (not running — polling only). */
  realtime: 'connected' | 'reconnecting' | 'off';
}

// src/sync/syncEngine.ts → `export const syncEngine: SyncEngine` and `export const useSyncStatus` (zustand hook)
// Syncs every few seconds while online (NetInfo), heartbeats every ~60 s, refreshes bootstrap/catalog when the
// server's catalog_version changes, enforces the terminal's offline limits.
export interface SyncEngine {
  start(): void;
  stop(): void;
  /** `checkVersions` (the manual "Sync now" buttons): also re-check the catalog / display / approvers versions. */
  syncNow(opts?: { checkVersions?: boolean }): Promise<void>;
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
