// One colour per settlement network. The node's fill says where an address lives; the ring
// around it says what the validators concluded (risk colour).

export interface NetworkStyle {
  key: string;
  label: string;
  color: string;
}

const STYLES: NetworkStyle[] = [
  { key: "ferra", label: "Ferra (Swissquote)", color: "#D4001A" },
  { key: "ton", label: "TON", color: "#2FA8E8" },
  { key: "ethereum", label: "Ethereum", color: "#8C9EFF" },
  { key: "sepolia", label: "Sepolia / Base", color: "#B4AAFF" },
  { key: "bitcoin", label: "Bitcoin", color: "#F7931A" },
  { key: "solana", label: "Solana", color: "#2EE6A6" },
  { key: "other", label: "Other", color: "#8A8F9A" },
];

export function networkStyle(name: string): NetworkStyle {
  const n = name.toLowerCase();
  const key = n.includes("sepolia") || n.includes("base")
    ? "sepolia"
    : n.startsWith("eth")
      ? "ethereum"
      : n.startsWith("ton")
        ? "ton"
        : n.startsWith("bitcoin") || n.startsWith("btc")
          ? "bitcoin"
          : n.startsWith("sol")
            ? "solana"
            : n.startsWith("ferra")
              ? "ferra"
              : "other";
  return STYLES.find((s) => s.key === key) ?? STYLES[STYLES.length - 1];
}

export function networkLegend(names: string[]): NetworkStyle[] {
  const keys = new Set(names.map((n) => networkStyle(n).key));
  return STYLES.filter((s) => keys.has(s.key) || s.key === "ferra");
}
