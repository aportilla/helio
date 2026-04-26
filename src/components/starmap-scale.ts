import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';

@customElement('starmap-scale')
export class StarmapScale extends LitElement {
  static styles = css`
    :host {
      position: fixed;
      bottom: 18px;
      left: 18px;
      pointer-events: none;
      font-family: 'VT323', monospace;
      color: #e8f6ff;
      letter-spacing: 1px;
      text-shadow: 0 0 4px rgba(0, 0, 16, 0.9);
    }

    .bar {
      position: relative;
      height: 6px;
      display: flex;
      align-items: center;
      border-top: 1px solid #e8f6ff;
    }

    .bar .end {
      position: absolute;
      width: 1px;
      height: 6px;
      background: #e8f6ff;
    }

    .bar .end.left  { left: 0; }
    .bar .end.right { right: 0; }

    .label {
      font-size: 14px;
      margin-top: 2px;
      text-align: center;
    }
  `;

  @state() private step = 5;
  @state() private widthPx = 100;

  setScale(step: number, widthPx: number): void {
    if (this.step === step && this.widthPx === widthPx) return;
    this.step = step;
    this.widthPx = widthPx;
  }

  render() {
    const w = `${this.widthPx}px`;
    const labelText = this.step === 1 ? '1 Light Year' : `${this.step} Light Years`;
    return html`
      <div class="bar" style=${styleMap({ width: w })}>
        <span class="end left"></span>
        <span class="end right"></span>
      </div>
      <div class="label" style=${styleMap({ width: w })}>${labelText}</div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'starmap-scale': StarmapScale;
  }
}
