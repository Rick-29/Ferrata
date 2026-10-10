import { useState } from 'react';
import { Button, Field } from '../ui/components';

type Props = {
  readonly isBusy: boolean;
  readonly onSubmit: (username: string, password: string) => void;
};

export function LoginStep({ isBusy, onSubmit }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const canSubmit = username.trim() !== '' && password !== '';
  return (
    <>
      <Field label="Identifiant Swissquote" value={username} onChangeText={setUsername} textContentType="username" />
      <Field
        label="Mot de passe"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        textContentType="password"
        hint="Démo : alice / demo"
        onSubmitEditing={() => canSubmit && onSubmit(username, password)}
      />
      <Button label="Se connecter" isBusy={isBusy} isDisabled={!canSubmit} onPress={() => onSubmit(username, password)} />
    </>
  );
}
