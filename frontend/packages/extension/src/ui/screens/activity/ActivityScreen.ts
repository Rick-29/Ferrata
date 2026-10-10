import { html, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { toActivityRows, type ActivityRow } from '../../core/activity';
import { screenHeader } from '../../core/header';
import { Screen } from '../../core/Screen';
import { screenStyles, textStyles } from '../../core/styles';
import { failed, loading, ready, type WidgetState } from '../../core/Widget';
import '../../widgets/activity-list/ActivityList';
import '../../widgets/button/Button';

/** Everything that happened on the account, read from the Ferra chain and the audit log. */
@customElement('sq-activity-screen')
export class ActivityScreen extends Screen {
  @state() private rows: WidgetState<readonly ActivityRow[]> = loading;

  static override styles = [screenStyles, textStyles];

  override connectedCallback(): void {
    super.connectedCallback();
    void this.#load();
  }

  override render(): TemplateResult {
    return html`
      ${screenHeader({
        title: 'Activité',
        onBack: () => this.router.go('home', undefined),
        action: html`<sq-button variant="ghost" ?disabled=${this.rows.kind === 'loading'} @click=${this.#load}>
          Actualiser
        </sq-button>`,
      })}
      <sq-activity-list .state=${this.rows} @retry=${this.#load}></sq-activity-list>
    `;
  }

  readonly #load = async (): Promise<void> => {
    this.rows = loading;
    const result = await this.bridge.getActivity();
    if (!this.isConnected) return;
    this.rows = result.ok ? ready(toActivityRows(result.value)) : failed(result.error);
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-activity-screen': ActivityScreen;
  }
}
