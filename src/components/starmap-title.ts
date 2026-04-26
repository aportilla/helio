import { LitElement, css, html } from 'lit';
import { customElement } from 'lit/decorators.js';

@customElement('starmap-title')
export class StarmapTitle extends LitElement {
  static styles = css`
    :host {
      position: fixed;
      top: 14px;
      left: 18px;
      pointer-events: none;
      color: var(--label);
      font-family: 'VT323', monospace;
      text-shadow: 0 0 6px rgba(94, 200, 255, 0.35);
      font-size: 20px;
      letter-spacing: 2px;
      border-left: 2px solid var(--grid-bright);
      padding-left: 10px;
      line-height: 1.1;
    }

    .sub {
      font-size: 13px;
      color: var(--label-dim);
      letter-spacing: 1px;
    }
  `;

  render() {
    return html`
      NEARBY STARS
      <div class="sub">&lt; 20 LIGHT YEARS · SOLAR NEIGHBOURHOOD</div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'starmap-title': StarmapTitle;
  }
}
