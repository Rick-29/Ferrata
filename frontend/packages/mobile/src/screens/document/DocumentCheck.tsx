import { File } from 'expo-file-system';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { checkDocument, DOCUMENT_LABELS, type DocumentFacts, type DocumentType } from '../../identity/checks';
import { Body, Button, Card, Eyebrow } from '../../ui/components';
import { SPACE, useTheme } from '../../ui/theme';
import { DocumentCapture } from './DocumentCapture';
import { DocumentDataForm } from './DocumentDataForm';
import { DocumentScan, type ChipRead } from './DocumentScan';

export interface DocumentResult {
  readonly type: DocumentType;
  readonly holderName: string;
}

type Props = {
  readonly isFaceChecked: boolean;
  readonly onDone: (result: DocumentResult) => void;
};

type Phase = 'type' | 'front' | 'back' | 'data' | 'chip' | 'scan';

/** ID-1 cards (ID card, licence) are 85.6 x 54 mm; a passport data page 125 x 88 mm. */
const CARD_RATIO = 85.6 / 54;
const PASSPORT_RATIO = 125 / 88;
const CHIP_READ_MS = 2_200;
const TYPES: readonly DocumentType[] = ['id-card', 'passport', 'driver-license'];

/** Deletes the temporary photos. Best effort: a file already gone is not an error worth showing. */
function deletePhotos(uris: readonly string[]): void {
  for (const uri of uris) {
    try {
      new File(uri).delete();
    } catch {
      // Already removed by the OS cache cleanup.
    }
  }
}

/**
 * Identity document check: type → photos (front, back) → data (MRZ or printed fields) → NFC chip
 * → scan. REAL: camera / gallery, MRZ check digits, age, validity, document type. SIMULATED (Expo
 * Go has no OCR, face model or NFC): document detection, face match, chip reading. Photos stay
 * on the phone and are deleted at the end. Never the only factor (CLAUDE.md rule 5).
 */
export function DocumentCheck({ isFaceChecked, onDone }: Props) {
  const t = useTheme();
  const [phase, setPhase] = useState<Phase>('type');
  const [type, setType] = useState<DocumentType>('id-card');
  const [images, setImages] = useState<readonly string[]>([]);
  const [facts, setFacts] = useState<DocumentFacts | null>(null);
  const [chip, setChip] = useState<ChipRead>('none');
  const [isReadingChip, setReadingChip] = useState(false);

  // Delete the photos whatever way the screen is left.
  const latestImages = useRef(images);
  useEffect(() => {
    latestImages.current = images;
  }, [images]);
  useEffect(() => () => deletePhotos(latestImages.current), []);

  useEffect(() => {
    if (!isReadingChip) return undefined;
    const id = setTimeout(() => {
      setReadingChip(false);
      setChip('read');
      setPhase('scan');
    }, CHIP_READ_MS);
    return () => clearTimeout(id);
  }, [isReadingChip]);

  const restart = (): void => {
    deletePhotos(images);
    setImages([]);
    setFacts(null);
    setChip('none');
    setPhase('type');
  };

  const ratio = type === 'passport' ? PASSPORT_RATIO : CARD_RATIO;
  const hasBack = type !== 'passport';

  if (phase === 'type') {
    return (
      <Card>
        <Eyebrow color={t.accent}>Pièce d'identité</Eyebrow>
        <Body muted>Quel document voulez-vous utiliser ? Il doit être à votre nom et en cours de validité.</Body>
        <View style={styles.choices}>
          {TYPES.map((option) => (
            <Button
              key={option}
              label={DOCUMENT_LABELS[option]}
              variant={option === type ? 'primary' : 'secondary'}
              onPress={() => setType(option)}
            />
          ))}
        </View>
        <Button label="Continuer" onPress={() => setPhase('front')} />
      </Card>
    );
  }

  if (phase === 'front' || phase === 'back') {
    const isFront = phase === 'front';
    const side = type === 'passport' ? 'Page photo du passeport' : isFront ? 'Recto' : 'Verso';
    return (
      <DocumentCapture
        key={phase}
        title={`${DOCUMENT_LABELS[type]} · ${side}`}
        hint={isFront ? 'Le côté avec votre photo.' : 'Le côté avec la bande de lecture (MRZ) ou les catégories.'}
        aspectRatio={ratio}
        onCaptured={(uri) => {
          setImages((current) => [...current, uri]);
          setPhase(isFront && hasBack ? 'back' : 'data');
        }}
      />
    );
  }

  if (phase === 'data' || facts === null) {
    return (
      <DocumentDataForm
        type={type}
        onRead={(read) => {
          setFacts(read);
          setPhase(read.type === 'driver-license' ? 'scan' : 'chip');
        }}
      />
    );
  }

  if (phase === 'chip') {
    return (
      <Card>
        <Eyebrow color={t.medium}>Puce NFC · lecture simulée</Eyebrow>
        <Body muted>
          Les passeports et cartes d'identité suisses ont une puce signée par l'État. Sa vraie lecture demande une
          application compilée (pas Expo Go) : ici, elle est simulée.
        </Body>
        {isReadingChip ? (
          <View style={styles.reading}>
            <ActivityIndicator color={t.accent} />
            <Text style={{ color: t.text }}>Gardez le document contre le dos du téléphone…</Text>
          </View>
        ) : (
          <>
            <Button label="Lire la puce (simulé)" onPress={() => setReadingChip(true)} />
            <Button label="Passer" variant="secondary" onPress={() => setPhase('scan')} />
          </>
        )}
      </Card>
    );
  }

  return (
    <DocumentScan
      facts={facts}
      checks={checkDocument(facts, new Date())}
      images={images}
      isFaceChecked={isFaceChecked}
      chip={chip}
      onRetry={restart}
      onDone={() => {
        deletePhotos(images);
        setImages([]);
        onDone({ type, holderName: facts.holderName });
      }}
    />
  );
}

const styles = StyleSheet.create({
  choices: { gap: SPACE.sm },
  reading: { flexDirection: 'row', gap: SPACE.md, alignItems: 'center' },
});
