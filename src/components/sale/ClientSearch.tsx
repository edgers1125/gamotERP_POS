// Online search of the company's clients (GET /pos/clients?search=, ≥ 2 characters — needs a connection and an
// online cashier session). Offline, the cashier records a new named client instead (merged on sync).
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { PosClient } from '@pos-api/contract';
import { api } from '../../api/client';
import { cashierSession } from '../../auth/cashierSession';
import { TextField } from '../../ui/components';
import { colors, font, radius, spacing } from '../../ui/theme';
import { clientName, statutoryTypeLabel } from '../../sale/statutory';
import { HintText } from './ui';

export function canSearchClients(online: boolean): boolean {
  return online && cashierSession.current()?.mode === 'ONLINE';
}

export function ClientSearch({ online, selectedId, onPick }: { online: boolean; selectedId: number | null; onPick: (c: PosClient) => void }) {
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
        {online ? 'Finding an existing client needs an online sign-in (you unlocked with your PIN).' : 'Finding an existing client needs a connection.'} Record a new
        client instead — it’s matched to an existing record when the sale syncs.
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
            style={({ pressed }) => [styles.row, on && styles.rowOn, pressed && { opacity: 0.8 }]}
          >
            <Text style={[styles.name, on && { color: '#fff' }]}>{clientName(c)}</Text>
            <Text style={[styles.meta, on && { color: '#fff' }]}>
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

const styles = StyleSheet.create({
  row: {
    minHeight: 56,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.xs,
    backgroundColor: colors.surface,
    justifyContent: 'center',
  },
  rowOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  name: { fontSize: font.body, fontWeight: '600', color: colors.text },
  meta: { fontSize: font.small, color: colors.muted },
  error: { color: colors.danger, fontSize: font.small },
});
