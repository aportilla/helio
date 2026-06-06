// PlanetGridDiagram — flat 2D test grid of 30 synthetic bodies, rendered
// through the real disc path so a tuning edit can be eyeballed across the whole
// resource × tier sweep at once. Coordinator only, mirroring SystemDiagram:
// owns the Scene + OrthographicCamera (1 unit = 1 buffer px), holds the disc
// layer and the caption layer, and threads resize → layout through them.
//
// Unlike SystemDiagram there are no real stars: the bodies are synthetic and
// self-contained, so the crescent lighting is driven by ONE fixed synthetic
// light placed above the grid (top-center) rather than pulled from a cluster.

import { OrthographicCamera, Scene } from 'three';
import { GridLabels } from './grid-labels';
import { PlanetGridLayer } from './planet-grid-layer';
import { buildTestGrid, type TestCell } from './test-bodies';
import type { StarLightSource } from '../system-diagram/types';

// Fraction of the viewport height the synthetic light sits ABOVE the top edge.
// The disc lighting reads a screen-space subsolar direction (normalize(lightPos
// − discCenter)), so parking the light well above the grid lights every cell's
// crescent from the top — a single consistent "sun overhead" key across all 40
// discs. Off-screen (negative-ish y in buffer space, since y is UP and the
// light sits above the top edge) keeps the direction shallow and uniform.
const LIGHT_ABOVE_FRAC = 0.6;

// Synthetic light color + intensity. Warm white at full intensity — a neutral
// key so the crescent reads on every cell regardless of its surface palette.
const LIGHT_COLOR: readonly [number, number, number] = [1.0, 0.96, 0.9];
const LIGHT_INTENSITY = 1.0;

export class PlanetGridDiagram {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);

  private bufferW = 1;
  private bufferH = 1;

  // Built once — the synthetic bodies never change, so the grid is fixed for
  // the diagram's lifetime.
  private readonly cells: readonly TestCell[];
  private readonly layer: PlanetGridLayer;
  private readonly labels: GridLabels;

  constructor() {
    this.cells = buildTestGrid();
    this.layer = new PlanetGridLayer(this.scene, this.cells);
    this.labels = new GridLabels(this.scene, this.cells);
  }

  resize(bufferW: number, bufferH: number): void {
    this.bufferW = bufferW;
    this.bufferH = bufferH;
    this.camera.left = 0; this.camera.right = bufferW;
    this.camera.bottom = 0; this.camera.top = bufferH;
    this.camera.updateProjectionMatrix();
    this.layout();
  }

  private layout(): void {
    // Synthetic top-center key light, in buffer-pixel coords. y sits above the
    // top edge (top = bufferH under the Y-UP frame), so the subsolar direction
    // points up-and-into-screen for every disc. Buffer-relative, so it's cheap
    // to rebuild each layout rather than tracking when it changes.
    const light: StarLightSource = {
      x: this.bufferW * 0.5,
      y: this.bufferH + this.bufferH * LIGHT_ABOVE_FRAC,
      r: this.bufferH,
      color: LIGHT_COLOR,
      intensity: LIGHT_INTENSITY,
    };
    this.layer.setLightSources([light]);
    this.layer.layout(this.bufferW, this.bufferH);
    this.labels.layout(this.layer.getCenters());
  }

  dispose(): void {
    this.layer.dispose();
    this.labels.dispose();
  }
}
