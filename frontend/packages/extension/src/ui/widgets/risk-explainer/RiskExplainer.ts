import type { Reason } from '@sqw/types/Reason';
import type { RiskBand } from '@sqw/types/RiskBand';
import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { BAND_LABELS, REASON_EXPLAINERS, REASON_LABELS, SCORE_SCALE, bandColor } from '../../core/risk-copy';
import { textStyles } from '../../core/styles';
import { Widget } from '../../core/Widget';

export interface RiskExplainerData {
  readonly score: number;
  readonly band: RiskBand;
  readonly reasons: readonly Reason[];
  /** Hops from the recipient to a flagged address, when the exposure graph found one. */
  readonly exposureHops: number | null;
  /** Share of the balance of the sent asset this transfer moves (0..1), from the simulation. */
  readonly balanceShare: number | null;
}

/**
 * "Pourquoi cet avertissement ?" (self-custody): Swissquote's risk function laid open, so the user
 * can decide on their own. Each signal with its weight in the score, what it means, what to do.
 */
@customElement('sq-risk-explainer')
export class RiskExplainer extends Widget<RiskExplainerData> {
  static override styles = [
    textStyles,
    css`
      .backdrop {
        position: fixed;
        inset: 0;
        z-index: 20;
        display: grid;
        align-items: end;
        background: rgba(4, 6, 14, 0.66);
      }
      .sheet {
        display: grid;
        gap: 11px;
        max-height: 88vh;
        overflow-y: auto;
        padding: 16px 14px 14px;
        border-radius: 20px 20px 0 0;
        background: var(--sq-surface, #141726);
        border-top: 1px solid var(--sq-border);
        box-sizing: border-box;
      }
      h2 {
        font: 600 14px var(--sq-font-display);
      }
      .scale {
        display: grid;
        grid-template-columns: 25fr 25fr 30fr 20fr;
        height: 6px;
        border-radius: 3px;
        overflow: hidden;
      }
      .scale span {
        opacity: 0.35;
      }
      .scale span.on {
        opacity: 1;
      }
      .legend {
        display: flex;
        justify-content: space-between;
        font-size: 9px;
        color: var(--sq-text-muted);
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 7px;
      }
      li {
        display: grid;
        gap: 4px;
        padding: 9px 10px;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.04);
      }
      .row {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        font-size: 11px;
        font-weight: 600;
      }
      .share {
        font-variant-numeric: tabular-nums;
        color: var(--sq-risk-medium);
      }
      .bar {
        height: 3px;
        border-radius: 2px;
        background: var(--sq-risk-medium);
      }
      p {
        margin: 0;
        font-size: 10px;
        line-height: 1.45;
      }
      .advice {
        color: var(--sq-text);
      }
      .facts,
      .decide {
        padding: 9px 10px;
        border-radius: 12px;
        border: 1px solid var(--sq-border);
      }
      button {
        padding: 9px;
        border: 0;
        border-radius: var(--sq-radius-sm);
        font: 600 11px var(--sq-font);
        color: var(--sq-accent-text);
        background: var(--sq-brand-gradient);
        cursor: pointer;
      }
    `,
  ];

  protected override renderReady(data: RiskExplainerData): TemplateResult {
    const total = data.reasons.reduce((sum, r) => sum + r.points, 0);
    const sorted = [...data.reasons].sort((a, b) => b.points - a.points);
    return html`
      <div class="backdrop" @click=${this.#close}>
        <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="explainer-title" @click=${(e: Event) => e.stopPropagation()}>
          <h2 id="explainer-title">Pourquoi cet avertissement ?</h2>
          <p>
            Score ${data.score}/100 · <strong style="color: ${bandColor(data.band)}">${BAND_LABELS[data.band]}</strong>.
            Swissquote additionne les signaux ci-dessous ; chacun pèse un nombre de points.
          </p>
          <div class="scale" aria-hidden="true">
            ${SCORE_SCALE.map(
              (s) => html`<span class=${s.band === data.band ? 'on' : ''} style="background: ${bandColor(s.band)}"></span>`,
            )}
          </div>
          <div class="legend">${SCORE_SCALE.map((s) => html`<span>${BAND_LABELS[s.band]} · ${s.from}+</span>`)}</div>
          ${sorted.length === 0
            ? html`<p class="muted">Aucun signal de risque détecté. Cela ne garantit pas que la transaction est sûre.</p>`
            : html`<ul aria-label="Détail des signaux">
                ${sorted.map((r) => this.#reason(r, total))}
              </ul>`}
          ${this.#facts(data)}
          <div class="decide">
            <p>
              <strong>Vous décidez.</strong> Swissquote vous informe mais ne bloque jamais une transaction : votre passkey
              suffit. Si vous confirmez, l’avertissement et votre décision sont inscrits dans votre journal Ferra chain.
            </p>
          </div>
          <button type="button" @click=${this.#close}>J’ai compris</button>
        </section>
      </div>
    `;
  }

  #reason(r: Reason, total: number): TemplateResult {
    const share = total > 0 ? Math.round((r.points / total) * 100) : 0;
    const copy = REASON_EXPLAINERS[r.code];
    return html`<li>
      <div class="row">
        <span>${REASON_LABELS[r.code] ?? r.message}</span>
        <span class="share">+${r.points} pts · ${share} %</span>
      </div>
      <div class="bar" style="width: ${share}%"></div>
      ${copy
        ? html`<p class="muted">${copy.why}</p>
            <p class="advice">→ ${copy.advice}</p>`
        : html`<p class="muted">${r.message}</p>`}
    </li>`;
  }

  #facts(data: RiskExplainerData): TemplateResult | typeof nothing {
    const facts: string[] = [];
    if (data.balanceShare !== null) facts.push(`Cet envoi représente ${Math.round(data.balanceShare * 100)} % de votre solde de cet actif.`);
    if (data.exposureHops !== null) {
      facts.push(
        data.exposureHops === 0
          ? 'Le destinataire est lui-même une adresse signalée.'
          : `Le destinataire est à ${data.exposureHops} intermédiaire(s) d’une adresse signalée.`,
      );
    }
    if (facts.length === 0) return nothing;
    return html`<div class="facts">${facts.map((f) => html`<p>${f}</p>`)}</div>`;
  }

  readonly #close = (): void => this.emit('explainer-closed', undefined);
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-risk-explainer': RiskExplainer;
  }
}
