import { LitElement, css, html, nothing } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { StarmapScene } from '../scene/scene';
import './starmap-boot';

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
      /* Render buffer is upscaled to fit the CSS box. Default linear scaling
         softens edges on hi-DPI — nearest-neighbor preserves the crisp
         pixel-art look. */
      image-rendering: pixelated;
      image-rendering: crisp-edges;
      /* Mobile Safari otherwise hijacks two-finger pinch as page zoom and
         single-finger drag as page pan, swallowing the events the scene
         needs to drive orbit/pinch-zoom itself. */
      touch-action: none;
    }
  `;

  @query('canvas') private canvasEl!: HTMLCanvasElement;

  @state() private bootFading = false;
  @state() private bootRemoved = false;

  private scene?: StarmapScene;

  firstUpdated(): void {
    this.scene = new StarmapScene(this.canvasEl);
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

  render() {
    return html`
      <canvas></canvas>
      ${this.bootRemoved ? nothing : html`<starmap-boot ?fading=${this.bootFading}></starmap-boot>`}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'starmap-app': StarmapApp;
  }
}
