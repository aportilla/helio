import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';

@customElement('starmap-controls')
export class StarmapControls extends LitElement {
  static styles = css`
    :host {
      position: fixed;
      bottom: 14px;
      right: 18px;
      pointer-events: auto;
      color: var(--label);
      font-family: 'VT323', monospace;
      text-shadow: 0 0 6px rgba(94, 200, 255, 0.35);
      font-size: 14px;
      letter-spacing: 1px;
      text-align: right;
      border-right: 2px solid var(--grid-bright);
      padding-right: 10px;
      line-height: 1.5;
    }

    button {
      font-family: 'VT323', monospace;
      font-size: 14px;
      background: transparent;
      color: var(--label);
      border: 1px solid var(--grid);
      padding: 2px 8px;
      cursor: pointer;
      letter-spacing: 1px;
    }

    button:hover {
      background: rgba(30, 111, 196, 0.18);
      color: #cfeeff;
    }

    button.on {
      background: rgba(30, 111, 196, 0.35);
      color: #fff;
      border-color: var(--grid-bright);
    }
  `;

  @state() private showLabels = true;
  @state() private showDrops = true;
  @state() private spinning = false;

  private toggleLabels() {
    this.showLabels = !this.showLabels;
    this.dispatchEvent(new CustomEvent('toggle-labels', { detail: this.showLabels }));
  }

  private toggleDrops() {
    this.showDrops = !this.showDrops;
    this.dispatchEvent(new CustomEvent('toggle-drops', { detail: this.showDrops }));
  }

  private toggleSpin() {
    this.spinning = !this.spinning;
    this.dispatchEvent(new CustomEvent('toggle-spin', { detail: this.spinning }));
  }

  private reset() {
    this.dispatchEvent(new CustomEvent('reset-view'));
  }

  render() {
    return html`
      <button class=${this.showLabels ? 'on' : ''} @click=${this.toggleLabels}>labels</button>
      <button class=${this.showDrops ? 'on' : ''} @click=${this.toggleDrops}>droplines</button>
      <button class=${this.spinning ? 'on' : ''} @click=${this.toggleSpin}>autospin</button>
      <button @click=${this.reset}>reset view</button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'starmap-controls': StarmapControls;
  }
}
