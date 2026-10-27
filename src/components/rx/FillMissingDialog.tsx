// "Fill in missing details" for a doctor on the list (Rx step, online only): inputs ONLY for what the doctor lacks
// (PosPrescriptionDoctor.missing). The server sets empty fields only — whatever is already on file is kept and reported
// back (`kept`), so the cashier sees nothing was overwritten.
import { useEffect, useState } from 'react';
import type { PosFillPrescriptionDoctorResponse, PosPrescriptionDoctor } from '@pos-api/contract';
import { ApiError } from '../../contracts';
import { doctorsCache } from '../../sale/doctors';
import { Banner, Button, TextField } from '../../ui/components';
import { makeStyles } from '../../ui/brandTheme';
import { spacing } from '../../ui/theme';
import { Sheet } from '../sale/ui';

type Missing = PosPrescriptionDoctor['missing'][number];

export const MISSING_LABELS: Record<Missing, string> = {
  license_number: 'PRC licence no.',
  clinic: 'Clinic',
  specialty: 'Specialty',
  ptr_number: 'PTR no.',
  s2_license_number: 'S2 licence no.',
};

export function FillMissingDialog({
  visible,
  doctor,
  onDone,
  onClose,
}: {
  visible: boolean;
  doctor: PosPrescriptionDoctor | null;
  onDone: (res: PosFillPrescriptionDoctorResponse) => void;
  onClose: () => void;
}) {
  const styles = useStyles();
  const [values, setValues] = useState<Partial<Record<Missing, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]> | null>(null);

  useEffect(() => {
    if (!visible) return;
    setValues({});
    setBusy(false);
    setError(null);
    setFieldErrors(null);
  }, [visible, doctor?.id]);

  if (!doctor) return null;
  const doc = doctor;
  const filled = doc.missing.filter((k) => (values[k] ?? '').trim() !== '');

  async function save() {
    if (busy) return;
    if (filled.length === 0) {
      setError('Type at least one of the missing details.');
      return;
    }
    const body: Partial<Record<Missing, string>> = {};
    for (const k of filled) body[k] = k === 'license_number' ? (values[k] ?? '').replace(/\s+/g, '') : (values[k] ?? '').trim();
    setBusy(true);
    setError(null);
    setFieldErrors(null);
    try {
      onDone(await doctorsCache.fillMissing(doc.id, body));
    } catch (e) {
      if (e instanceof ApiError) {
        setFieldErrors(e.fieldErrors);
        setError(e.isNetwork ? 'No connection to the server — filling in details needs one.' : e.message);
      } else {
        setError(e instanceof Error ? e.message : 'The details couldn’t be saved.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      visible={visible}
      title={`Fill in missing details — ${doc.name}`}
      onClose={() => !busy && onClose()}
      width={560}
      footer={
        <>
          <Button title="Cancel" variant="ghost" onPress={onClose} disabled={busy} />
          <Button title="Save details" onPress={() => void save()} loading={busy} />
        </>
      }
    >
      {error ? <Banner kind="danger" message={error} style={styles.banner} /> : null}
      {doc.missing.map((k) => (
        <TextField
          key={k}
          label={MISSING_LABELS[k]}
          value={values[k] ?? ''}
          onChangeText={(v) => setValues((p) => ({ ...p, [k]: v }))}
          keyboardType={k === 'license_number' ? 'number-pad' : 'default'}
          maxLength={k === 'clinic' ? 200 : k === 'specialty' ? 100 : k === 'license_number' ? 24 : 30}
          error={fieldErrors?.[k]?.[0] ?? null}
          editable={!busy}
        />
      ))}
    </Sheet>
  );
}

const useStyles = makeStyles(() => ({
  banner: { marginBottom: spacing.md },
}));
