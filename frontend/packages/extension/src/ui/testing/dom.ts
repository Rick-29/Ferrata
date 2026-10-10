import type { LitElement } from 'lit';

// Test helpers: our UI is shadow roots all the way down, so plain querySelector stops at the first one.

/** First element matching `selector` anywhere under `root`, piercing every shadow root. */
export function deepQuery<E extends Element = HTMLElement>(root: ParentNode, selector: string): E | null {
  const direct = root.querySelector<E>(selector);
  if (direct) return direct;
  const own = root instanceof Element ? [root] : [];
  for (const el of [...own, ...Array.from(root.querySelectorAll('*'))]) {
    const shadow = el.shadowRoot;
    if (!shadow) continue;
    const found = deepQuery<E>(shadow, selector);
    if (found) return found;
  }
  return null;
}

/** Visible text of an element including its shadow tree, whitespace collapsed. */
export function deepText(el: Element): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? '');
    if (node instanceof Element && node.shadowRoot) walk(node.shadowRoot);
    node.childNodes.forEach(walk);
  };
  walk(el);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/** Lets pending promises (the fake bridge with no delay) and Lit updates run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export async function mount<E extends LitElement>(el: E): Promise<E> {
  document.body.append(el);
  await el.updateComplete;
  return el;
}
