import { Camera, Scene, Sprite, SpriteMaterial, Vector3 } from 'three';
import { STARS } from '../data/stars';
import { makeLabelTexture } from '../data/pixel-font';

interface StarLabel {
  sprite: Sprite;
  starIdx: number;
  w: number;
  h: number;
  isSun: boolean;
}

interface AxisLabel {
  sprite: Sprite;
  w: number;
  h: number;
}

const labelMat = (tex: ReturnType<typeof makeLabelTexture>['tex']) => new SpriteMaterial({
  map: tex, transparent: true, depthTest: false, depthWrite: false,
});

// 3D Sprites that stay coordinate-locked to their world points. NearestFilter
// throughout — sprite world-positions are snapped onto the integer pixel grid
// each frame so 1 font pixel = 1 screen pixel.
export class Labels {
  private readonly starLabels: StarLabel[] = [];
  private readonly axisLabels: AxisLabel[] = [];
  private readonly gcSprite: Sprite;
  private readonly gcSize: { w: number; h: number };
  private readonly tipSprite: Sprite;
  private readonly tipMat: SpriteMaterial;
  private tipSize: { w: number; h: number } = { w: 0, h: 0 };

  private showLabels = true;
  private hovered = -1;
  private lastHovered = -1;

  // Reusable per-frame scratch so the tick loop doesn't allocate.
  private readonly _camRight = new Vector3();
  private readonly _camUp    = new Vector3();
  private readonly _camFwd   = new Vector3();
  private readonly _projTmp  = new Vector3();

  constructor(scene: Scene) {
    // Star labels — Sun's label is warm-white rather than yellow so it stays
    // readable when its sprite overlaps the equally-yellow Sun dot.
    STARS.forEach((s, idx) => {
      const isSun = s.name === 'Sun';
      const color = isSun ? '#ffffcc' : '#5ec8ff';
      const { tex, w, h } = makeLabelTexture(s.name, color);
      const sp = new Sprite(labelMat(tex));
      sp.renderOrder = 10;
      sp.position.set(s.x, s.y, s.z);
      scene.add(sp);
      this.starLabels.push({ sprite: sp, starIdx: idx, w, h, isSun });
    });

    // Galactic-centre pointer label.
    const gc = makeLabelTexture('► GALACTIC CENTRE', '#3a8fe0');
    this.gcSprite = new Sprite(labelMat(gc.tex));
    this.gcSprite.renderOrder = 10;
    this.gcSprite.position.set(27, 0, 0);
    this.gcSize = { w: gc.w, h: gc.h };
    scene.add(this.gcSprite);

    // Axis tick labels at the four cardinal directions.
    const axes: ReadonlyArray<readonly [string, number, number, number]> = [
      ['0°',    21,  0, 0],
      ['90°',    0, 21, 0],
      ['180°', -21,  0, 0],
      ['270°',   0,-21, 0],
    ];
    for (const [text, x, y, z] of axes) {
      const t = makeLabelTexture(text, '#2d7ab8');
      const sp = new Sprite(labelMat(t.tex));
      sp.renderOrder = 10;
      sp.position.set(x, y, z);
      scene.add(sp);
      this.axisLabels.push({ sprite: sp, w: t.w, h: t.h });
    }

    // Hover tooltip — texture rebuilt only on hover transitions.
    this.tipMat = new SpriteMaterial({
      transparent: true, depthTest: false, depthWrite: false,
    });
    this.tipSprite = new Sprite(this.tipMat);
    this.tipSprite.visible = false;
    this.tipSprite.renderOrder = 11;
    scene.add(this.tipSprite);
  }

  setShowLabels(show: boolean): void {
    this.showLabels = show;
    this.gcSprite.visible = show;
    for (const a of this.axisLabels) a.sprite.visible = show;
  }

  setHovered(idx: number): void {
    this.hovered = idx;
  }

  // Snap a sprite so its top-left quad corner lands on an integer buffer
  // pixel. We snap the *corner*, not the *center*, so all four corners are
  // integer-aligned regardless of sprite dimension parity. Snapping only the
  // center leaves odd-dimension sprites with half-integer corners — and the
  // GPU's rasterization rule then covers (size − 1) pixels instead of (size),
  // skipping one row/column of texels at the edge. The artifact is most
  // visible on small labels at the screen center (e.g. "Sun" when the camera
  // target is the Sun) where the projection lands on an exact pixel boundary.
  private snapToPixelGrid(out: Vector3, wpp: number, camera: Camera, viewportW: number, viewportH: number, spriteW: number, spriteH: number): void {
    this._projTmp.copy(out).project(camera);
    const sx = (this._projTmp.x * 0.5 + 0.5) * viewportW;
    const sy = (this._projTmp.y * 0.5 + 0.5) * viewportH;
    // Top-left corner in screen-up coords (Y grows up): (sx − w/2, sy + h/2).
    const cornerX = sx - spriteW * 0.5;
    const cornerY = sy + spriteH * 0.5;
    out.addScaledVector(this._camRight, (Math.floor(cornerX + 0.5) - cornerX) * wpp);
    out.addScaledVector(this._camUp,    (Math.floor(cornerY + 0.5) - cornerY) * wpp);
  }

  update(camera: Camera, viewDistance: number, viewportW: number, viewportH: number): void {
    // Hover tooltip: rebuild texture only when hovered star changes.
    if (this.hovered >= 0) {
      if (this.lastHovered !== this.hovered) {
        const s = STARS[this.hovered];
        if (this.tipMat.map) this.tipMat.map.dispose();
        const { tex, w, h } = makeLabelTexture([
          { text: s.name,                color: '#ffe98a' },
          { text: '  · ' + s.cls + ' · ', color: '#2d7ab8' },
          { text: s.distLy.toFixed(2) + ' ly', color: '#aee4ff' },
        ], { box: true });
        this.tipMat.map = tex;
        this.tipMat.needsUpdate = true;
        this.tipSize = { w, h };
        this.lastHovered = this.hovered;
      }
      this.tipSprite.visible = true;
    } else {
      this.tipSprite.visible = false;
      this.lastHovered = -1;
    }

    // 1 font pixel maps to 1 screen pixel via the wpp factor.
    const wpp = viewDistance / viewportH;
    camera.matrixWorld.extractBasis(this._camRight, this._camUp, this._camFwd);

    for (const L of this.starLabels) {
      if (!this.showLabels) { L.sprite.visible = false; continue; }
      const s = STARS[L.starIdx];
      L.sprite.visible = true;
      L.sprite.scale.set(L.w * wpp, L.h * wpp, 1);
      // Sun's dot is bigger and shares its label color, so needs more clearance.
      const offsetPx = Math.round(L.h * 0.5) + (L.isSun ? 22 : 6);
      L.sprite.position.set(s.x, s.y, s.z).addScaledVector(this._camUp, offsetPx * wpp);
      this.snapToPixelGrid(L.sprite.position, wpp, camera, viewportW, viewportH, L.w, L.h);
    }

    this.gcSprite.scale.set(this.gcSize.w * wpp, this.gcSize.h * wpp, 1);
    this.gcSprite.position.set(24 + (this.gcSize.w * 0.5 + 6) * wpp, 0, 0);

    for (const a of this.axisLabels) {
      a.sprite.scale.set(a.w * wpp, a.h * wpp, 1);
    }

    if (this.tipSprite.visible && this.hovered >= 0) {
      const s = STARS[this.hovered];
      this.tipSprite.scale.set(this.tipSize.w * wpp, this.tipSize.h * wpp, 1);
      const offsetPx = Math.round(this.tipSize.h * 0.5) + 18;
      this.tipSprite.position.set(s.x, s.y, s.z).addScaledVector(this._camUp, offsetPx * wpp);
      this.snapToPixelGrid(this.tipSprite.position, wpp, camera, viewportW, viewportH, this.tipSize.w, this.tipSize.h);
    }
  }
}
