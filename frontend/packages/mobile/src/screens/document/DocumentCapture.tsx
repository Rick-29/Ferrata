import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { useRef, useState } from 'react';
import { Image, Linking, StyleSheet, Text, View } from 'react-native';
import { Body, Button, Card, Eyebrow } from '../../ui/components';
import { RADIUS, SPACE, useTheme } from '../../ui/theme';

type Props = {
  readonly title: string;
  readonly hint: string;
  /** Width / height of the document, for the framing guide (ID-1 card or passport page). */
  readonly aspectRatio: number;
  readonly onCaptured: (uri: string) => void;
};

const PHOTO_QUALITY = 0.6;

/**
 * REAL: back camera with a framing guide, or a photo picked from the gallery. The image stays a
 * temporary file on this phone (deleted when the check ends); it is not uploaded anywhere.
 */
export function DocumentCapture({ title, hint, aspectRatio, onCaptured }: Props) {
  const t = useTheme();
  const camera = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [isCameraOn, setCameraOn] = useState(false);
  const [isReady, setReady] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openCamera = async (): Promise<void> => {
    const granted = permission?.granted === true || (await requestPermission()).granted;
    if (!granted) {
      setError("l'accès à la caméra a été refusé");
      return;
    }
    setError(null);
    setReady(false);
    setCameraOn(true);
  };

  const shoot = async (): Promise<void> => {
    try {
      const photo = await camera.current?.takePictureAsync({ quality: PHOTO_QUALITY, shutterSound: false });
      if (!photo) return;
      setCameraOn(false);
      setPreview(photo.uri);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const pick = async (): Promise<void> => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: PHOTO_QUALITY });
    const asset = result.canceled ? undefined : result.assets[0];
    if (asset) setPreview(asset.uri);
  };

  const isDenied = permission !== null && !permission.granted && !permission.canAskAgain;

  return (
    <Card>
      <Eyebrow color={t.accent}>{title}</Eyebrow>
      <Body muted>{hint}</Body>
      {isCameraOn ? (
        <>
          <View style={[styles.frame, { aspectRatio: aspectRatio * 0.9 }]}>
            <CameraView
              ref={camera}
              style={StyleSheet.absoluteFill}
              facing="back"
              onCameraReady={() => setReady(true)}
              onMountError={(e) => {
                setError(e.message);
                setCameraOn(false);
              }}
            />
            <View pointerEvents="none" style={[styles.guide, { aspectRatio, borderColor: t.accent }]} />
          </View>
          <Text style={[styles.caption, { color: t.muted }]}>
            Placez le document dans le cadre, à plat, sans reflet.
          </Text>
          <Button label="Prendre la photo" isDisabled={!isReady} onPress={() => void shoot()} />
          <Button label="Annuler" variant="secondary" onPress={() => setCameraOn(false)} />
        </>
      ) : preview ? (
        <>
          <Image source={{ uri: preview }} style={[styles.preview, { aspectRatio }]} resizeMode="cover" />
          <Text style={[styles.caption, { color: t.muted }]}>Le texte est-il net et lisible ?</Text>
          <Button label="Utiliser cette photo" onPress={() => onCaptured(preview)} />
          <Button label="Reprendre" variant="secondary" onPress={() => setPreview(null)} />
        </>
      ) : (
        <>
          {error ? <Body muted>La caméra n'a pas pu démarrer : {error}</Body> : null}
          {isDenied ? (
            <Button label="Autoriser la caméra dans les réglages" onPress={() => void Linking.openSettings()} />
          ) : (
            <Button label="Photographier le document" onPress={() => void openCamera()} />
          )}
          <Button label="Téléverser depuis la galerie" variant="secondary" onPress={() => void pick()} />
        </>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    borderRadius: RADIUS.md,
    overflow: 'hidden',
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  guide: { width: '86%', borderWidth: 3, borderRadius: SPACE.md, borderStyle: 'dashed' },
  preview: { width: '100%', borderRadius: RADIUS.md },
  caption: { fontSize: 12, textAlign: 'center' },
});
