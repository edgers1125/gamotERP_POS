// P-A1 — the POS API client (src/contracts.ts `PosApi`), implementing backend/src/pos-api/contract.ts exactly.
//   * Enrollment calls carry no auth (gated by the one-time code).
//   * POST /pos/device/token carries only a DPoP proof; the device token it returns is cached in memory and re-fetched
//     shortly before it expires, or once after a 401.
//   * Device calls: `Authorization: DPoP <device token>` + `DPoP: <proof with ath>`.
//   * Cashier calls: additionally `X-Cashier-Token` from cashierSession.tokenForApi() (P-A4; imported lazily — that
//     module imports this one).
// Every failure is an ApiError: status 0 = network/timeout (offline), code DEVICE_REVOKED / APP_UPDATE_REQUIRED from
// the server, fieldErrors from a Zod 400 (message = the first field error, as the web app shows).
import * as Crypto from 'expo-crypto';

import type {
  CashierSessionRequest,
  CashierSessionResponse,
  DeviceTokenResponse,
  EnrollChallengeRequest,
  EnrollChallengeResponse,
  EnrollRequest,
  EnrollResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  PosApprovalKind,
  PosApprover,
  PosBootstrap,
  PosCatalog,
  PosClient,
  PosRefundRequest,
  PosRefundResponse,
  PosSaleRow,
  PosStockRow,
  SyncOp,
  SyncRequest,
  SyncResponse,
} from '@pos-api/contract';
import { appVersionName } from '../config/runtime';
import { serverConfig } from '../config/serverConfig';
import { ApiError } from '../contracts';
import type { PosApi } from '../contracts';
import { base64ToBase64Url } from '../device/base64url';
import { deviceKey } from '../device/deviceKey';
import { jose } from '../device/jose';

const DEFAULT_TIMEOUT_MS = 20_000;
const LONG_TIMEOUT_MS = 60_000; // catalog download, sync batches, enrollment (key generation + Play Integrity)
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/** 426 from the server: this app build is older than the terminal's min_app_version. */
export class AppUpdateRequiredError extends ApiError {
  constructor(
    status: number,
    message: string,
    public minAppVersion: string | null,
  ) {
    super(status, message, 'APP_UPDATE_REQUIRED', null);
  }
}

/** The app's version as sent to the server (app.json `version` of the installed build). */
export function appVersion(): string {
  return appVersionName();
}

type AuthKind = 'none' | 'proof' | 'device' | 'cashier';

interface RequestSpec {
  method: 'GET' | 'POST';
  path: string; // e.g. "/pos/bootstrap"
  query?: Record<string, string | undefined>;
  body?: unknown;
  auth: AuthKind;
  timeoutMs?: number;
}

// ---- device access token (memory only) ----
let deviceToken: { token: string; expiresAt: number } | null = null;
let tokenInFlight: Promise<string> | null = null;

/** Forget the cached device token (e.g. after re-enrollment or revocation). */
export function resetDeviceToken() {
  deviceToken = null;
  tokenInFlight = null;
}

async function getDeviceToken(): Promise<string> {
  if (deviceToken && deviceToken.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) return deviceToken.token;
  if (!tokenInFlight) {
    tokenInFlight = (async () => {
      const res = await send<DeviceTokenResponse>({ method: 'POST', path: '/pos/device/token', auth: 'proof' });
      if (!res || typeof res.access_token !== 'string' || !res.access_token) {
        throw new ApiError(502, 'The server returned no device token');
      }
      const ttlMs = (Number(res.expires_in) > 0 ? Number(res.expires_in) : 60) * 1000;
      deviceToken = { token: res.access_token, expiresAt: Date.now() + ttlMs };
      return res.access_token;
    })().finally(() => {
      tokenInFlight = null;
    });
  }
  return tokenInFlight;
}

async function cashierToken(): Promise<string | null> {
  const { cashierSession } = await import('../auth/cashierSession');
  return cashierSession.tokenForApi();
}

// ---- transport ----

async function baseUrl(): Promise<string> {
  const base = await serverConfig.getBaseUrl();
  if (!base) throw new ApiError(0, 'No server is set up on this device — enroll it first', 'NOT_CONFIGURED');
  return base;
}

function buildUrl(base: string, path: string, query?: Record<string, string | undefined>): string {
  const qs = Object.entries(query ?? {})
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${base}${path}${qs ? `?${qs}` : ''}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function defaultMessage(status: number): string {
  if (status === 401) return 'This device is not authorized — try again, or re-enroll it';
  if (status === 403) return 'You are not allowed to do this';
  if (status === 404) return 'Not found on the server';
  if (status === 426) return 'This app is too old for the terminal — install the update';
  if (status === 429) return 'Too many attempts — wait a few minutes and try again';
  if (status >= 500) return 'The server had a problem — try again';
  return `Request failed (HTTP ${status})`;
}

function toApiError(status: number, body: unknown): ApiError {
  const b = isRecord(body) ? body : {};
  const details = isRecord(b.details) ? b.details : null;

  let fieldErrors: Record<string, string[]> | null = null;
  if (details && isRecord(details.fieldErrors)) {
    fieldErrors = {};
    for (const [field, msgs] of Object.entries(details.fieldErrors)) {
      if (Array.isArray(msgs)) {
        const list = msgs.filter((m): m is string => typeof m === 'string' && m.length > 0);
        if (list.length) fieldErrors[field] = list;
      }
    }
    if (Object.keys(fieldErrors).length === 0) fieldErrors = null;
  }
  const firstFieldError = fieldErrors ? Object.values(fieldErrors)[0]?.[0] : undefined;
  const formErrors = details && Array.isArray(details.formErrors) ? details.formErrors : [];
  const firstFormError = formErrors.find((m): m is string => typeof m === 'string' && m.length > 0);
  const serverMessage = typeof b.error === 'string' && b.error ? b.error : undefined;
  const message = firstFieldError ?? firstFormError ?? serverMessage ?? defaultMessage(status);

  const code = typeof b.code === 'string' && b.code ? b.code : status === 426 ? 'APP_UPDATE_REQUIRED' : null;
  if (code === 'APP_UPDATE_REQUIRED') {
    return new AppUpdateRequiredError(status, message, typeof b.min_app_version === 'string' ? b.min_app_version : null);
  }
  return new ApiError(status, message, code, fieldErrors);
}

async function send<T>(spec: RequestSpec, retried = false): Promise<T> {
  const url = buildUrl(await baseUrl(), spec.path, spec.query);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (spec.body !== undefined) headers['Content-Type'] = 'application/json';

  if (spec.auth === 'proof') {
    headers.DPoP = await jose.dpopProof(spec.method, url);
  } else if (spec.auth === 'device' || spec.auth === 'cashier') {
    let cashier: string | null = null;
    if (spec.auth === 'cashier') {
      cashier = await cashierToken();
      if (!cashier) {
        throw new ApiError(401, 'A cashier must sign in online to do this', 'CASHIER_SIGN_IN_REQUIRED');
      }
    }
    const token = await getDeviceToken();
    headers.Authorization = `DPoP ${token}`;
    headers.DPoP = await jose.dpopProof(spec.method, url, token);
    if (cashier) headers['X-Cashier-Token'] = cashier;
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let status: number;
  let text: string;
  try {
    const res = await fetch(url, {
      method: spec.method,
      headers,
      body: spec.body !== undefined ? JSON.stringify(spec.body) : undefined,
      signal: controller.signal,
    });
    status = res.status;
    text = await res.text();
  } catch {
    throw new ApiError(
      0,
      timedOut ? 'The server did not answer in time — check the connection' : 'Cannot reach the server — check the connection',
      timedOut ? 'TIMEOUT' : 'NETWORK',
    );
  } finally {
    clearTimeout(timer);
  }

  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (status >= 200 && status < 300) {
    if (body === null && text) throw new ApiError(502, 'The server sent an unreadable response');
    return body as T;
  }

  const error = toApiError(status, body);
  if (status === 401 && (spec.auth === 'device' || spec.auth === 'cashier') && error.code !== 'DEVICE_REVOKED') {
    // Token expired/rejected (server restart, clock skew…): get a fresh device token and try once more.
    resetDeviceToken();
    if (!retried) return send<T>(spec, true);
  }
  throw error;
}

function asArray<T>(value: unknown, what: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (isRecord(value) && Array.isArray(value.items)) return value.items as T[];
  throw new ApiError(502, `The server sent an unexpected ${what} list`);
}

// ---- the API ----

export const api: PosApi = {
  async enrollChallenge(code) {
    const body: EnrollChallengeRequest = { code: code.trim().toUpperCase() };
    return send<EnrollChallengeResponse>({ method: 'POST', path: '/pos/device/enroll/challenge', body, auth: 'none' });
  },

  async enroll({ code, challenge }) {
    resetDeviceToken();
    const { publicJwk, attestationChain } = await deviceKey.createKey(challenge.challenge);

    let integrityToken: string | null = null;
    if (challenge.play_integrity_cloud_project_number) {
      // requestHash = base64url(SHA-256(challenge)) — the challenge string as received (contract EnrollRequest).
      const hash = base64ToBase64Url(
        await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, challenge.challenge, {
          encoding: Crypto.CryptoEncoding.BASE64,
        }),
      );
      integrityToken = await deviceKey.integrityToken(hash, challenge.play_integrity_cloud_project_number);
    }

    const info = await deviceKey.deviceInfo();
    const body: EnrollRequest = {
      code: code.trim().toUpperCase(),
      public_key_jwk: publicJwk,
      attestation_chain: attestationChain,
      integrity_token: integrityToken,
      device: { model: info.model, serial: info.serial, app_version: appVersion(), android_sdk: info.androidSdk },
    };
    return send<EnrollResponse>({
      method: 'POST',
      path: '/pos/device/enroll',
      body,
      // The server requires a DPoP proof signed by the key being enrolled (proof of possession; the key now exists).
      auth: 'proof',
      timeoutMs: LONG_TIMEOUT_MS,
    });
  },

  async cashierSession(email, password, mfaCode) {
    const body: CashierSessionRequest = { email: email.trim(), password };
    if (mfaCode) body.mfa_code = mfaCode.trim();
    return send<CashierSessionResponse>({ method: 'POST', path: '/pos/session', body, auth: 'device' });
  },

  async bootstrap() {
    return send<PosBootstrap>({ method: 'GET', path: '/pos/bootstrap', auth: 'device' });
  },

  async catalog() {
    return send<PosCatalog>({ method: 'GET', path: '/pos/catalog', auth: 'device', timeoutMs: LONG_TIMEOUT_MS });
  },

  async clients(search) {
    const res = await send<unknown>({ method: 'GET', path: '/pos/clients', query: { search: search.trim() }, auth: 'cashier' });
    return asArray<PosClient>(res, 'client');
  },

  async approvers(kind: PosApprovalKind) {
    const res = await send<unknown>({ method: 'GET', path: '/pos/approvers', query: { kind }, auth: 'cashier' });
    return asArray<PosApprover>(res, 'approver');
  },

  async stock(skuIds) {
    if (skuIds.length === 0) return [];
    const res = await send<unknown>({ method: 'GET', path: '/pos/stock', query: { sku_ids: skuIds.join(',') }, auth: 'cashier' });
    return asArray<PosStockRow>(res, 'stock');
  },

  async sales(date) {
    const res = await send<unknown>({ method: 'GET', path: '/pos/sales', query: { date }, auth: 'cashier' });
    return asArray<PosSaleRow>(res, 'sales');
  },

  async sync(ops: SyncOp[]) {
    const body: SyncRequest = { ops };
    return send<SyncResponse>({ method: 'POST', path: '/pos/sync', body, auth: 'device', timeoutMs: LONG_TIMEOUT_MS });
  },

  async refund(input: PosRefundRequest) {
    return send<PosRefundResponse>({ method: 'POST', path: '/pos/refunds', body: input, auth: 'cashier', timeoutMs: LONG_TIMEOUT_MS });
  },

  async heartbeat(input: HeartbeatRequest) {
    return send<HeartbeatResponse>({ method: 'POST', path: '/pos/heartbeat', body: input, auth: 'device' });
  },
};
