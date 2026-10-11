import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { Body, Button, Card, Eyebrow, Field } from '../ui/components';
import { useTheme } from '../ui/theme';

type Props = {
  readonly isBusy: boolean;
  readonly onScanned: (text: string) => void;
  readonly onCancel: () => void;
};

/** Scans the QR shown by the extension (camera), or takes the code pasted by hand (emulators, demos). */
export function ScanStep({ isBusy, onScanned, onCancel }: Props) {
  const t = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [isCameraOn, setCameraOn] = useState(false);
  const [code, setCode] = useState('');
  const handled = useRef(false);

  const openCamera = async (): Promise<void> => {
    const granted = permission?.granted === true || (await requestPermission()).granted;
    if (granted) {
      handled.current = false;
      setCameraOn(true);
    }
  };

  const isDenied = permission !== null && !permission.granted && !permission.canAskAgain;

  return (
    <>
      <Card>
        <Eyebrow color={t.accent}>Scanner</Eyebrow>
        {isCameraOn ? (
          <View style={styles.frame}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => {
                // The camera fires repeatedly: hand over the first code only.
                if (handled.current) return;
                handled.current = true;
                setCameraOn(false);
                onScanned(data);
              }}
            />
          </View>
        ) : isDenied ? (
          <Button label="Autoriser la caméra dans les réglages" onPress={() => void Linking.openSettings()} />
        ) : (
          <Button label="Ouvrir la caméra" isBusy={isBusy} onPress={() => void openCamera()} />
        )}
      </Card>
      <Card>
        <Body muted>Pas de caméra ? Collez le code affiché sous le QR (il commence par « ferrata: »).</Body>
        <Field label="Code" value={code} onChangeText={setCode} placeholder="ferrata:…" mono autoCapitalize="none" />
        <Button label="Valider le code" variant="secondary" isBusy={isBusy} isDisabled={code.trim() === ''} onPress={() => onScanned(code)} />
      </Card>
      <Button label="Annuler" variant="secondary" onPress={onCancel} />
    </>
  );
}

const styles = StyleSheet.create({
  frame: { width: '100%', aspectRatio: 1, borderRadius: 16, overflow: 'hidden' },
});
