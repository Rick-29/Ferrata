import type { RecoveryState } from '@sqw/types/RecoveryState';
import type { Result, SdkError } from '@sqw/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking } from 'react-native';
import { createDeviceKey, loadDeviceKey, signAsRecoveryKey } from '../device/deviceKey';
import { keyFingerprint, parseFerrataLink } from './links';
import { errorMessage } from './messages';
import type { KycScript, RecoveryService } from './RecoveryService';

const DEVICE_LABEL = 'Téléphone de secours Ferrata';

/**
 * The recovery phone as a sequence of steps:
 *   login → home → scan → either `paired` (this phone is now the wallet's recovery phone, once
 *   the owner's passkey confirms on the computer), or `review` → `identify` → `approved` (the
 *   recovery started on a new computer is signed by this phone's key and the KYC is done; the
 *   computer finalises after the timelock).
 */
export type RecoveryStep =
  | { readonly kind: 'login' }
  | { readonly kind: 'home'; readonly displayName: string; readonly hasKey: boolean }
  | { readonly kind: 'scan'; readonly displayName: string }
  | { readonly kind: 'paired'; readonly displayName: string; readonly fingerprint: string; readonly address: string }
  | { readonly kind: 'review'; readonly displayName: string; readonly recovery: RecoveryState; readonly newKeyFingerprint: string }
  | { readonly kind: 'identify'; readonly displayName: string; readonly recovery: RecoveryState }
  | { readonly kind: 'approved'; readonly displayName: string; readonly recovery: RecoveryState };

export interface RecoveryFlow {
  readonly step: RecoveryStep;
  readonly busy: boolean;
  readonly error: string | null;
  /** A code opened the app (phone camera → Expo Go link); handled right after sign-in. */
  readonly hasPendingCode: boolean;
  login(username: string, password: string): Promise<void>;
  scan(): void;
  /** A scanned (or pasted) `ferrata:` link. */
  scanned(text: string): Promise<void>;
  confirmReview(): void;
  identify(script: KycScript, fullName: string): Promise<void>;
  home(): Promise<void>;
}

export function useRecoveryFlow(service: RecoveryService): RecoveryFlow {
  const [step, setStep] = useState<RecoveryStep>({ kind: 'login' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const displayName = step.kind === 'login' ? '' : step.displayName;

  /** One action at a time; the error of the last one is shown. */
  const run = useCallback(async <T,>(action: () => Promise<Result<T, SdkError>>, onOk: (value: T) => void): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const result = await action();
    busyRef.current = false;
    setBusy(false);
    if (result.ok) onOk(result.value);
    else setError(errorMessage(result.error));
  }, []);

  const goHome = useCallback(async (name: string) => {
    const key = await loadDeviceKey();
    setStep({ kind: 'home', displayName: name, hasKey: key !== null });
  }, []);

  const login = useCallback(
    (username: string, password: string) => run(() => service.login(username.trim(), password), (s) => void goHome(s.displayName)),
    [goHome, run, service],
  );

  const scan = useCallback(() => {
    setError(null);
    setStep({ kind: 'scan', displayName });
  }, [displayName]);

  const scanned = useCallback(
    async (text: string) => {
      const link = parseFerrataLink(text);
      if (!link) {
        setError('Ce code n’est pas un code Ferrata. Scannez le code affiché par l’extension.');
        return;
      }
      if (link.kind === 'pair') {
        // A fresh key for each association: the one a recovery used is never reused.
        await run(
          async () => {
            const key = await createDeviceKey();
            if (!key.ok) return key;
            const offered = await service.offerPairingKey(link.id, key.value.owner, DEVICE_LABEL);
            return offered.ok ? { ok: true as const, value: keyFingerprint(key.value.owner) } : offered;
          },
          (fingerprint) => setStep({ kind: 'paired', displayName, fingerprint, address: link.address }),
        );
        return;
      }
      await run(
        () => service.recovery(link.id),
        (recovery) => {
          if (recovery.status.state !== 'prepared') {
            setError('Cette récupération n’attend plus de téléphone (déjà approuvée, annulée ou expirée).');
            return;
          }
          setStep({ kind: 'review', displayName, recovery, newKeyFingerprint: keyFingerprint(recovery.new_owner) });
        },
      );
    },
    [displayName, run, service],
  );

  const confirmReview = useCallback(() => {
    if (step.kind !== 'review') return;
    setStep({ kind: 'identify', displayName, recovery: step.recovery });
  }, [displayName, step]);

  const identify = useCallback(
    async (script: KycScript, fullName: string) => {
      if (step.kind !== 'identify') return;
      const { recovery } = step;
      await run(
        async () => {
          // The phone's key approves this exact new owner, behind the phone's biometrics.
          const signature = await signAsRecoveryKey(recovery.recovery_hash);
          if (!signature.ok) return signature;
          return service.startRecovery(recovery.id, signature.value, { script, fullName: fullName.trim() });
        },
        (started) => setStep({ kind: 'approved', displayName, recovery: started }),
      );
    },
    [displayName, run, service, step],
  );

  // The phone's camera can open the app with a code (Expo Go deep link): keep it, and handle it as
  // if it had been scanned as soon as the user is signed in.
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  useEffect(() => {
    void Linking.getInitialURL().then((url) => {
      if (url && parseFerrataLink(url)) setPendingCode(url);
    });
    const subscription = Linking.addEventListener('url', ({ url }) => {
      if (parseFerrataLink(url)) setPendingCode(url);
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!pendingCode || step.kind === 'login' || busyRef.current) return;
    setPendingCode(null);
    void scanned(pendingCode);
  }, [pendingCode, scanned, step.kind]);

  const home = useCallback(() => {
    setError(null);
    return goHome(displayName);
  }, [displayName, goHome]);

  return { step, busy, error, hasPendingCode: pendingCode !== null, login, scan, scanned, confirmReview, identify, home };
}
