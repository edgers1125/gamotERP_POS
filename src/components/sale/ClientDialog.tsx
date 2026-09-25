// Who the sale is for: walk-in (no client — the default), an existing client (online search), or a new named client
// recorded on the device (no contact details; matched/created by the server on sync).
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { PosClient } from '@pos-api/contract';
import { Button, TextField } from '../../ui/components';
import { spacing } from '../../ui/theme';
import { newClientUuid, type SaleClient } from '../../sale/cart';
import { ClientSearch } from './ClientSearch';
import { HintText, SectionTitle, Segmented, Sheet } from './ui';

type Mode = 'WALK_IN' | 'EXISTING' | 'NEW';

export function ClientDialog({
  visible,
  value,
  online,
  onSave,
  onClose,
}: {
  visible: boolean;
  value: SaleClient;
  online: boolean;
  onSave: (client: SaleClient) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>(value.kind);
  const [existing, setExisting] = useState<PosClient | null>(value.kind === 'EXISTING' ? value.client : null);
  const [first, setFirst] = useState('');
  const [middle, setMiddle] = useState('');
  const [last, setLast] = useState('');

  useEffect(() => {
    if (!visible) return;
    setMode(value.kind);
    setExisting(value.kind === 'EXISTING' ? value.client : null);
    setFirst(value.kind === 'NEW' ? value.firstName : '');
    setMiddle(value.kind === 'NEW' ? value.middleName : '');
    setLast(value.kind === 'NEW' ? value.lastName : '');
  }, [visible, value]);

  const newOk = first.trim() !== '' || last.trim() !== '';
  const canSave = mode === 'WALK_IN' || (mode === 'EXISTING' && existing !== null) || (mode === 'NEW' && newOk);

  function save() {
    if (mode === 'WALK_IN') onSave({ kind: 'WALK_IN' });
    else if (mode === 'EXISTING' && existing) onSave({ kind: 'EXISTING', client: existing });
    else
      onSave({
        kind: 'NEW',
        clientUuid: value.kind === 'NEW' ? value.clientUuid : newClientUuid(),
        firstName: first.trim(),
        middleName: middle.trim(),
        lastName: last.trim(),
      });
    onClose();
  }

  return (
    <Sheet
      visible={visible}
      title="Client"
      onClose={onClose}
      footer={
        <>
          <Button title="Cancel" variant="ghost" onPress={onClose} />
          <Button title="Use this client" onPress={save} disabled={!canSave} />
        </>
      }
    >
      <Segmented
        options={[
          { value: 'WALK_IN', label: 'Walk-in' },
          { value: 'EXISTING', label: 'Existing client' },
          { value: 'NEW', label: 'New client' },
        ]}
        value={mode}
        onChange={setMode}
      />
      <View style={{ height: spacing.md }} />
      {mode === 'WALK_IN' ? <HintText>No client is recorded — the sale shows as “Walk-in”.</HintText> : null}
      {mode === 'EXISTING' ? (
        <ClientSearch online={online} selectedId={existing?.id ?? null} onPick={setExisting} />
      ) : null}
      {mode === 'NEW' ? (
        <View>
          <SectionTitle>Name (no contact details are taken at the POS)</SectionTitle>
          <View style={styles.row}>
            <TextField label="First name" value={first} onChangeText={setFirst} containerStyle={styles.cell} maxLength={100} />
            <TextField label="Middle name" value={middle} onChangeText={setMiddle} containerStyle={styles.cell} maxLength={100} />
            <TextField label="Last name" value={last} onChangeText={setLast} containerStyle={styles.cell} maxLength={100} />
          </View>
        </View>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: spacing.sm },
  cell: { flex: 1 },
});
