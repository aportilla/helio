import { LitElement, css, html, nothing } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { StarmapScene } from '../scene/scene';
import './starmap-title';
import './starmap-controls';
import './starmap-scale';
import './starmap-boot';
import type { StarmapScale } from './starmap-scale';

@customElement('starmap-app')
export class StarmapApp extends LitElement {
  static styles = css`
    :host { display: block; }

    canvas {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      display: block;
      /* Render buffer is 1:1 CSS pixels; the browser then scales that to
         physical pixels for display. Default linear scaling softens edges
         on hi-DPI — nearest-neighbor preserves the crisp pixel aesthetic. */
      image-rendering: pixelated;
      image-rendering: crisp-edges;
    }

    .overlay {
      position: fixed;
      inset: 0;
      pointer-events: none;
      background:
        radial-gradient(ellipse at center, transparent 55%, rgba(0, 0, 0, 0.55) 100%),
        repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.012) 0 1px, transparent 1px 3px);
    }
  `;

  @query('canvas') private canvasEl!: HTMLCanvasElement;
  @query('starmap-scale') private scaleEl!: StarmapScale;

  @state() private bootFading = false;
  @state() private bootRemoved = false;

  private scene?: StarmapScene;

  firstUpdated(): void {
    this.scene = new StarmapScene(this.canvasEl, {
      onScale: ({ step, widthPx }) => this.scaleEl.setScale(step, widthPx),
    });
    this.scene.start();

    // Hold the splash briefly, fade, then unmount.
    setTimeout(() => {
      this.bootFading = true;
      setTimeout(() => { this.bootRemoved = true; }, 600);
    }, 350);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.scene?.stop();
    this.scene = undefined;
  }

  private onToggleLabels(e: CustomEvent<boolean>) { this.scene?.setShowLabels(e.detail); }
  private onToggleDrops(e: CustomEvent<boolean>)  { this.scene?.setShowDroplines(e.detail); }
  private onToggleSpin(e: CustomEvent<boolean>)   { this.scene?.setSpin(e.detail); }
  private onResetView()                           { this.scene?.reset(); }

  render() {
    return html`
      <canvas></canvas>
      <div class="overlay"></div>
      <starmap-title></starmap-title>
      <starmap-controls
        @toggle-labels=${this.onToggleLabels}
        @toggle-drops=${this.onToggleDrops}
        @toggle-spin=${this.onToggleSpin}
        @reset-view=${this.onResetView}
      ></starmap-controls>
      <starmap-scale></starmap-scale>
      ${this.bootRemoved ? nothing : html`<starmap-boot ?fading=${this.bootFading}></starmap-boot>`}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'starmap-app': StarmapApp;
  }
}
