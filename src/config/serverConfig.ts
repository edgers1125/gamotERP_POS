// P-A1 — where the backend is (src/contracts.ts `ServerConfig`), kept in expo-secure-store. Set at enrollment from the
// QR code's server_url (or typed in), e.g. "http://10.0.2.2:4001/api" in development, "https://erp.example.com/api".
import * as SecureStore from 'expo-secure-store';

import type { ServerConfig } from '../contracts';

const KEY = 'gamoterp_pos.server_base_url';

let cached: string | null | undefined; // undefined = not read yet

/** Trims, drops trailing slashes and a query/fragment; refuses anything that isn't an absolute http(s) URL. */
export function normalizeBaseUrl(input: string): string {
  let url = input.trim();
  const cut = url.search(/[?#]/);
  if (cut !== -1) url = url.slice(0, cut);
  url = url.replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+(\/\S*)?$/i.test(url)) {
    throw new Error('Enter the server address, starting with https:// (or http:// for local testing)');
  }
  return url;
}

export const serverConfig: ServerConfig = {
  async getBaseUrl() {
    if (cached !== undefined) return cached;
    try {
      cached = (await SecureStore.getItemAsync(KEY)) || null;
    } catch {
      cached = null;
    }
    return cached;
  },

  async setBaseUrl(url) {
    const normalized = normalizeBaseUrl(url);
    await SecureStore.setItemAsync(KEY, normalized);
    cached = normalized;
  },
};
