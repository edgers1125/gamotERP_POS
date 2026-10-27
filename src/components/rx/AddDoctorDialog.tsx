// "Doctor not in the list — add" (Rx step, online only): the web's Add Doctor form. Name and PRC licence are required
// (PRC: digits, spaces dropped), the rest optional; sent only when not blank. A 409 (the PRC is already on file) names
// that doctor — an active one can be used right away. Field errors from the server sit under their field.
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { PosCreatePrescriptionDoctorRequest } from '@pos-api/contract';
import { ApiError } from '../../contracts';
import { doctorsCache, licenseTakenDoctor } from '../../sale/doctors';
import { Banner, Button, TextField } from '../../ui/components';
import { makeStyles } from '../../ui/brandTheme';
import { spacing } from '../../ui/theme';
import { Sheet } from '../sale/ui';

export function AddDoctorDialog({ visible, onPicked, onClose }: { visible: boolean; onPicked: (doctorId: number) => void; onClose: () => void }) {
  const styles = useStyles();
  const [name, setName] = useState('');
  const [prc, setPrc] = useState('');
  const [clinic, setClinic] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [ptr, setPtr] = useState('');
  const [s2, setS2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]> | null>(null);
  const [taken, setTaken] = useState<{ id: number; name: string; is_active: boolean } | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setName('');
    setPrc('');
    setClinic('');
    setSpecialty('');
    setPtr('');
    setS2('');
    setBusy(false);
    setError(null);
    setFieldErrors(null);
    setTaken(null);
    setTouched(false);
  }, [visible]);

  const prcClean = prc.replace(/\s+/g, '');
  const localName = name.trim() === '' ? 'Enter the doctor’s name.' : null;
  const localPrc = prcClean === '' ? 'Enter the PRC licence number.' : !/^\d+$/.test(prcClean) ? 'The PRC licence is digits only.' : null;
  const fe = (k: string) => fieldErrors?.[k]?.[0] ?? null;

  async function save() {
    setTouched(true);
    if (busy || localName || localPrc) return;
    const body: PosCreatePrescriptionDoctorRequest = { name: name.trim(), license_number: prcClean };
    if (clinic.trim()) body.clinic = clinic.trim();
    if (specialty.trim()) body.specialty = specialty.trim();
    if (ptr.trim()) body.ptr_number = ptr.trim();
    if (s2.trim()) body.s2_license_number = s2.trim();
    setBusy(true);
    setError(null);
    setFieldErrors(null);
    setTaken(null);
    try {
      const d = await doctorsCache.add(body);
      onPicked(d.id);
    } catch (e) {
      setTaken(licenseTakenDoctor(e));
      if (e instanceof ApiError) {
        setFieldErrors(e.fieldErrors);
        setError(e.isNetwork ? 'No connection to the server — adding a doctor needs one.' : e.message);
      } else {
        setError(e instanceof Error ? e.message : 'The doctor couldn’t be added.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      visible={visible}
      title="Add a doctor"
      onClose={() => !busy && onClose()}
      width={620}
      footer={
        <>
          <Button title="Cancel" variant="ghost" onPress={onClose} disabled={busy} />
          <Button title="Add doctor" onPress={() => void save()} loading={busy} />
        </>
      }
    >
      {error ? (
        <Banner
          kind="danger"
          message={error}
          actionLabel={taken?.is_active ? `Use ${taken.name}` : undefined}
          onAction={taken?.is_active ? () => onPicked(taken.id) : undefined}
          style={styles.banner}
        />
      ) : null}
      <TextField label="Name" value={name} onChangeText={setName} maxLength={150} error={fe('name') ?? (touched ? localName : null)} editable={!busy} />
      <TextField
        label="PRC licence no."
        value={prc}
        onChangeText={setPrc}
        keyboardType="number-pad"
        maxLength={24}
        error={fe('license_number') ?? (touched ? localPrc : null)}
        editable={!busy}
      />
      <TextField label="Clinic (optional)" value={clinic} onChangeText={setClinic} maxLength={200} error={fe('clinic')} editable={!busy} />
      <TextField label="Specialty (optional)" value={specialty} onChangeText={setSpecialty} maxLength={100} error={fe('specialty')} editable={!busy} />
      <View style={styles.row}>
        <TextField label="PTR no. (optional)" value={ptr} onChangeText={setPtr} maxLength={30} error={fe('ptr_number')} containerStyle={styles.cell} editable={!busy} />
        <TextField label="S2 licence no. (optional)" value={s2} onChangeText={setS2} maxLength={30} error={fe('s2_license_number')} containerStyle={styles.cell} editable={!busy} />
      </View>
      <Text style={styles.note}>The doctor joins the company’s doctors list for every branch.</Text>
    </Sheet>
  );
}

const useStyles = makeStyles((c, t) => ({
  banner: { marginBottom: spacing.md },
  row: { flexDirection: 'row', gap: spacing.md },
  cell: { flex: 1 },
  note: { ...t.caption, color: c.muted, marginTop: spacing.sm },
}));
