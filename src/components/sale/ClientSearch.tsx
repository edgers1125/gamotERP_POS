// Online search of the company's clients (GET /pos/clients?search=, ≥ 2 characters — needs a connection and an
// online cashier session). Offline, the cashier records a new named client instead (merged on sync).
import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { PosClient } from '@pos-api/contract';
import { api } from '../../api/client';
import { cashierSession } from '../../auth/cashierSession';
import { TextField } from '../../ui/components';
import { makeStyles, useThemeColors } from '../../ui/brandTheme';
import { radius, spacing } from '../../ui/theme';
import { clientName, statutoryTypeLabel } from '../../sale/statutory';
import { HintText } from './ui';

/**
 * Client lookups (GET /pos/clients) need the network AND a live online cashier token. A PIN unlock gives no token
 * (unless it resumed the same cashier's still-valid online session), and an online token lapses after
 * CASHIER_TOKEN_TTL_SECONDS while the session still says ONLINE — so the token itself is checked, not just the mode
 * (checking only the mode let every lookup fail silently with CASHIER_SIGN_IN_REQUIRED once the token expired).
 */
export function canSearchClients(online: boolean): boolean {
  return online && cashierSession.isOnlineSession();
}

/** Why returning clients can't be looked up right now (null = they can). Never weakens auth — it only explains. */
export function clientLookupUnavailableReason(online: boolean): string | null {
  if (canSearchClients(online)) return null;
  if (!online) return 'Offline — returning clients can’t be looked up now.';
  if (cashierSession.current()?.mode === 'ONLINE') return 'Your online sign-in has expired — sign in with your password again to look up returning clients.';
  return 'Sign in with your password to look up returning clients — a PIN unlock works offline only.';
}

export function ClientSearch({ online, selectedId, onPick }: { online: boolean; selectedId: number | null; onPick: (c: PosClient) => void }) {
  const styles = useStyles();
  const theme = useThemeColors();
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<PosClient[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const seq = useRef(0);
  const enabled = canSearchClients(online);

  useEffect(() => {
    const q = query.trim();
    if (!enabled || q.length < 2) {
      setRows([]);
      setState('idle');
      return;
    }
    const mine = ++seq.current;
    setState('loading');
    const t = setTimeout(() => {
      api
        .clients(q)
        .then((list) => {
          if (mine !== seq.current) return;
          setRows(list);
          setState('idle');
        })
        .catch(() => {
          if (mine === seq.current) setState('error');
        });
    }, 350);
    return () => clearTimeout(t);
  }, [query, enabled]);

  if (!enabled) {
    return (
      <HintText>
        {clientLookupUnavailableReason(online)} Record a new client instead — it’s matched to an existing record when the device checks in.
      </HintText>
    );
  }

  return (
    <View>
      <TextField
        value={query}
        onChangeText={setQuery}
        placeholder="Name, phone or Senior/PWD ID number"
        autoCorrect={false}
        containerStyle={{ marginBottom: spacing.sm }}
      />
      {state === 'loading' ? <HintText>Searching…</HintText> : null}
      {state === 'error' ? <Text style={styles.error}>Couldn’t search clients — check the connection.</Text> : null}
      {state === 'idle' && query.trim().length >= 2 && rows.length === 0 ? <HintText>No client matches.</HintText> : null}
      {rows.slice(0, 20).map((c) => {
        const on = c.id === selectedId;
        return (
          <Pressable
            key={c.id}
            accessibilityRole="button"
            onPress={() => onPick(c)}
            style={({ pressed }) => [styles.row, on && styles.rowOn, pressed && !on && { backgroundColor: theme.primarySoft }]}
          >
            <Text style={[styles.name, on && { color: theme.primary }]}>{clientName(c)}</Text>
            <Text style={styles.meta}>
              {[c.phone_number, c.statutory_type ? `${statutoryTypeLabel(c.statutory_type)} ${c.statutory_id_number ?? ''}` : null]
                .filter(Boolean)
                .join('  ·  ') || 'No contact details'}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const useStyles = makeStyles((c, t) => ({
  row: {
    minHeight: 56,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.xs,
    backgroundColor: c.surface,
    justifyContent: 'center',
  },
  rowOn: { backgroundColor: c.primarySoft, borderColor: c.primary },
  name: { ...t.bodyStrong },
  meta: { ...t.caption },
  error: { ...t.caption, color: c.danger },
}));
