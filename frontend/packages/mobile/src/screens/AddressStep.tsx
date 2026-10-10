import { useState } from 'react';
import { Body, Button, Field } from '../ui/components';

type Props = {
  readonly displayName: string;
  readonly isBusy: boolean;
  readonly onSubmit: (address: string) => void;
};

export function AddressStep({ displayName, isBusy, onSubmit }: Props) {
  const [address, setAddress] = useState('');
  return (
    <>
      <Body muted>
        Bonjour {displayName}. Quel wallet voulez-vous récupérer ? Son adresse figure dans vos relevés Swissquote et dans
        les Réglages de l'extension.
      </Body>
      <Field label="Adresse du wallet" value={address} onChangeText={setAddress} placeholder="0x…" mono />
      <Body muted>
        Une nouvelle passkey va être créée sur ce téléphone. Elle remplacera l'ancienne une fois la récupération terminée.
      </Body>
      <Button label="Créer ma nouvelle passkey" isBusy={isBusy} isDisabled={address.trim() === ''} onPress={() => onSubmit(address)} />
    </>
  );
}
