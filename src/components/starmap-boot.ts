import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('starmap-boot')
export class StarmapBoot extends LitElement {
  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg);
      z-index: 10;
      color: var(--label);
      font-family: 'VT323', monospace;
      font-size: 18px;
      letter-spacing: 3px;
      transition: opacity 0.5s;
    }

    :host([fading]) { opacity: 0; }

    .blink { animation: blink 1s steps(2) infinite; }
    @keyframes blink { 50% { opacity: 0; } }
  `;

  @property({ type: Boolean, reflect: true }) fading = false;

  render() {
    return html`INITIALIZING STELLAR CATALOG<span class="blink">_</span>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'starmap-boot': StarmapBoot;
  }
}
