import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { apiUrl, createRecoveryService } from './src/config';
import { useRecoveryFlow, type RecoveryStep } from './src/recovery/useRecoveryFlow';
import { AddressStep } from './src/screens/AddressStep';
import { FinishedStep } from './src/screens/FinishedStep';
import { IdentifyStep } from './src/screens/IdentifyStep';
import { LoginStep } from './src/screens/LoginStep';
import { WaitingStep } from './src/screens/WaitingStep';
import { CryptoBackdrop } from './src/ui/CryptoBackdrop';
import { Body, Brand, ErrorBanner, Eyebrow, Steps, Title } from './src/ui/components';
import { SPACE, useTheme } from './src/ui/theme';

const STEP_LABELS = ['Connexion', 'Wallet', 'Identité', 'Délai'] as const;

const HEADINGS: Readonly<Record<RecoveryStep['kind'], string>> = {
  login: 'Récupérer mon wallet',
  address: 'Quel wallet ?',
  identify: 'Vérifions votre identité',
  waiting: 'Récupération en cours',
  finished: 'Récupération',
};

const STEP_INDEX: Readonly<Record<RecoveryStep['kind'], number>> = {
  login: 0,
  address: 1,
  identify: 2,
  waiting: 3,
  finished: 3,
};

/**
 * Ferrata (APP_NAME), recovery app: this phone is the new device of a client who lost their
 * passkey. Login → wallet → new passkey + simulated video identification → timelock → rotation.
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
          <View style={styles.header}>
            <Eyebrow color="#d78cff">Étape {STEP_INDEX[step.kind] + 1} sur 4</Eyebrow>
            <Title>{HEADINGS[step.kind]}</Title>
          </View>
          <Steps current={STEP_INDEX[step.kind]} labels={STEP_LABELS} />
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
      return <LoginStep isBusy={flow.busy} onSubmit={flow.login} />;
    case 'address':
      return <AddressStep displayName={step.displayName} isBusy={flow.busy} onSubmit={flow.chooseWallet} />;
    case 'identify':
      return <IdentifyStep isBusy={flow.busy} onSubmit={flow.identify} />;
    case 'waiting':
      return <WaitingStep recovery={step.recovery} isBusy={flow.busy} onExecute={flow.execute} />;
    case 'finished':
      return <FinishedStep recovery={step.recovery} onRestart={flow.restart} />;
  }
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: SPACE.xl, paddingTop: 72, paddingBottom: SPACE.xxl, gap: SPACE.xl },
  header: { gap: SPACE.sm },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
});
