// What the phone scans. Shared by the background (real bridge) and the fake bridge.
// The phone already knows the Swissquote API it talks to: the QR carries no API URL, only ids.
//
// By default the QR holds a `ferrata:` link, read by the app's own scanner. With
// VITE_PHONE_LINK_BASE set to the Expo dev server (e.g. `exp://192.168.1.20:8081/--/`), it holds
// an Expo Go deep link instead: the phone's camera opens the app straight on the right screen.

const base = (): string => {
  const configured = import.meta.env?.VITE_PHONE_LINK_BASE;
  if (typeof configured !== 'string' || configured === '') return 'ferrata:';
  return configured.endsWith('/') ? configured : `${configured}/`;
};

/** Pairing a recovery phone: `ferrata:pair?id=…&address=…` (or the Expo Go link). */
export function pairingQr(pairingId: string, address: string): string {
  return `${base()}pair?${new URLSearchParams({ v: '1', id: pairingId, address }).toString()}`;
}

/** Approving a recovery from the phone: `ferrata:recover?id=…` (or the Expo Go link). */
export function recoveryQr(recoveryId: string): string {
  return `${base()}recover?${new URLSearchParams({ v: '1', id: recoveryId }).toString()}`;
}
