import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { apiUrl, createRecoveryService } from './src/config';
import { useRecoveryFlow, type RecoveryStep } from './src/recovery/useRecoveryFlow';
import { FinishedStep } from './src/screens/FinishedStep';
import { HomeStep } from './src/screens/HomeStep';
import { IdentifyStep } from './src/screens/IdentifyStep';
import { LoginStep } from './src/screens/LoginStep';
import { PairedStep } from './src/screens/PairedStep';
import { ReviewStep } from './src/screens/ReviewStep';
import { ScanStep } from './src/screens/ScanStep';
import { CryptoBackdrop } from './src/ui/CryptoBackdrop';
import { Body, Brand, ErrorBanner, Eyebrow, Title } from './src/ui/components';
import { SPACE, useTheme } from './src/ui/theme';

const HEADINGS: Readonly<Record<RecoveryStep['kind'], string>> = {
  login: 'Téléphone de secours',
  home: 'Téléphone de secours',
  scan: 'Scanner le code',
  paired: 'Comparer l’empreinte',
  review: 'Approuver la récupération ?',
  identify: 'Vérifions votre identité',
  approved: 'Récupération',
};

/**
 * Ferrata (APP_NAME), the recovery phone: associated with the wallet (its key registered by the
 * owner's passkey), it approves a recovery started on a new computer, with the KYC. It never
 * holds the wallet and never moves funds; Swissquote alone cannot recover without it.
 */
export default function App() {
  const t = useTheme();
  const [service] = useState(createRecoveryService);
  const flow = useRecoveryFlow(service);
  const { step } = flow;

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <StatusBar style="light" />
      <CryptoBackdrop />
      <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.brandRow}>
            <Brand />
            <Eyebrow>· Récupération</Eyebrow>
          </View>
          <Title>{HEADINGS[step.kind]}</Title>
          <ErrorBanner message={flow.error} />
          {renderStep(step, flow)}
          <Body muted>{apiUrl ? `Service : ${apiUrl}` : 'Mode démo : données simulées, aucun serveur.'}</Body>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function renderStep(step: RecoveryStep, flow: ReturnType<typeof useRecoveryFlow>) {
  switch (step.kind) {
    case 'login':
      return (
        <>
          {flow.hasPendingCode ? <Body>Code Ferrata reçu : connectez-vous pour continuer.</Body> : null}
          <LoginStep isBusy={flow.busy} onSubmit={flow.login} />
        </>
      );
    case 'home':
      return <HomeStep displayName={step.displayName} hasKey={step.hasKey} onScan={flow.scan} />;
    case 'scan':
      return <ScanStep isBusy={flow.busy} onScanned={(text) => void flow.scanned(text)} onCancel={() => void flow.home()} />;
    case 'paired':
      return <PairedStep fingerprint={step.fingerprint} address={step.address} onDone={() => void flow.home()} />;
    case 'review':
      return (
        <ReviewStep
          recovery={step.recovery}
          newKeyFingerprint={step.newKeyFingerprint}
          onConfirm={flow.confirmReview}
          onCancel={() => void flow.home()}
        />
      );
    case 'identify':
      return <IdentifyStep isBusy={flow.busy} onSubmit={(script, name) => void flow.identify(script, name)} />;
    case 'approved':
      return <FinishedStep recovery={step.recovery} onDone={() => void flow.home()} />;
  }
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: SPACE.xl, paddingTop: 72, paddingBottom: SPACE.xxl, gap: SPACE.xl },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
});
