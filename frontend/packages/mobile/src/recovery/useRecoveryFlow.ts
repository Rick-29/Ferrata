import type { RecoveryState } from '@sqw/types/RecoveryState';
import type { Result, SdkError } from '@sqw/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './messages';
import type { KycScript, NewPasskey, RecoveryService } from './RecoveryService';

const POLL_MS = 3000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The recovery as a sequence of steps. `waiting` polls the backend, because an existing device
 * can cancel at any moment during the timelock.
 */
export type RecoveryStep =
  | { readonly kind: 'login' }
  | { readonly kind: 'address'; readonly displayName: string }
  | { readonly kind: 'identify'; readonly address: string; readonly passkey: NewPasskey }
  | { readonly kind: 'waiting'; readonly recovery: RecoveryState }
  | { readonly kind: 'finished'; readonly recovery: RecoveryState };

export interface RecoveryFlow {
  readonly step: RecoveryStep;
  readonly busy: boolean;
  readonly error: string | null;
  login(username: string, password: string): Promise<void>;
  chooseWallet(address: string): Promise<void>;
  identify(script: KycScript, fullName: string): Promise<void>;
  execute(): Promise<void>;
  restart(): void;
}

const isFinal = (r: RecoveryState): boolean => r.status.state !== 'pending';

export function useRecoveryFlow(service: RecoveryService): RecoveryFlow {
  const [step, setStep] = useState<RecoveryStep>({ kind: 'login' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

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

  const login = useCallback(
    (username: string, password: string) =>
      run(() => service.login(username.trim(), password), (s) => setStep({ kind: 'address', displayName: s.displayName })),
    [run, service],
  );

  const chooseWallet = useCallback(
    async (address: string) => {
      const trimmed = address.trim();
      if (!ADDRESS.test(trimmed)) {
        setError('Adresse invalide : 0x suivi de 40 caractères hexadécimaux.');
        return;
      }
      await run(() => service.createPasskey(), (passkey) => setStep({ kind: 'identify', address: trimmed, passkey }));
    },
    [run, service],
  );

  const identify = useCallback(
    async (script: KycScript, fullName: string) => {
      if (step.kind !== 'identify') return;
      const { address, passkey } = step;
      await run(
        () => service.start(address, passkey.owner, { script, fullName: fullName.trim() }),
        (recovery) => setStep(isFinal(recovery) ? { kind: 'finished', recovery } : { kind: 'waiting', recovery }),
      );
    },
    [run, service, step],
  );

  const execute = useCallback(async () => {
    if (step.kind !== 'waiting') return;
    await run(() => service.execute(step.recovery.id), (recovery) => setStep({ kind: 'finished', recovery }));
  }, [run, service, step]);

  const restart = useCallback(() => {
    setError(null);
    setStep({ kind: 'login' });
  }, []);

  // While waiting, watch for a cancellation from an existing device.
  const waitingId = step.kind === 'waiting' ? step.recovery.id : null;
  useEffect(() => {
    if (!waitingId) return undefined;
    let active = true;
    const timer = setInterval(() => {
      void service.status(waitingId).then((result) => {
        if (!active || !result.ok) return;
        const recovery = result.value;
        // Only update the recovery still on screen: a late answer must not undo "finished".
        setStep((current) =>
          current.kind === 'waiting' && current.recovery.id === recovery.id
            ? isFinal(recovery)
              ? { kind: 'finished', recovery }
              : { kind: 'waiting', recovery }
            : current,
        );
      });
    }, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [service, waitingId]);

  return { step, busy, error, login, chooseWallet, identify, execute, restart };
}
