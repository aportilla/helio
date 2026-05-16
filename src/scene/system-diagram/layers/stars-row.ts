// Stars row — each cluster member is a Mesh + PlaneGeometry disc
// whose center sits ABOVE the buffer top by STAR_OFFSCREEN_FRAC of
// the disc radius, so the GPU clips the offscreen portion and the
// visible sliver reads as "huge body, mostly hidden up there".
// Mesh (not Points) is load-bearing here: GL_POINTS discards any
// sprite whose vertex falls outside the clip volume, but the
// triangle path rasterizes fine with vertices outside the viewport.

import { Mesh, PlaneGeometry, Scene, ShaderMaterial, Vector2 } from 'three';
import { CLASS_COLOR, STARS, type StarCluster } from '../../../data/stars';
import { sizes } from '../../../ui/theme';
import { makeStarMeshMaterial } from '../../materials';
import {
  DISC_SCALE, MIN_STAR_GAP, STAR_HORIZ_GAP_FACTOR, STAR_OFFSCREEN_FRAC,
} from '../layout/constants';
import { bigMiddleOrder, sumOf } from '../layout/row';
import type { BodyPick } from '../types';

interface StarDisc {
  mesh: Mesh;
  geometry: PlaneGeometry;
  material: ShaderMaterial;
  // Cached current diameter in px — used to detect when layout()
  // needs to rebuild the geometry (size changed under width-fit scaling).
  currentDiam: number;
}

export class StarsRowLayer {
  // starMembers[slot] is the source star index after the big-middle
  // sort. starDiscs[slot] is the corresponding mesh.
  private readonly starMembers: readonly number[];
  private readonly starSlotDiscPx: readonly number[];
  private readonly starDiscs: StarDisc[] = [];

  constructor(scene: Scene, cluster: StarCluster) {
    // Sort by disc size descending, then permute into big-middle slot
    // order so geometry indices map directly to lateral slots.
    const rawDiscPx = cluster.members.map(m => Math.floor(STARS[m].pxSize * DISC_SCALE + 0.5));
    const sortedIdx = cluster.members.map((_, i) => i).sort((a, b) => rawDiscPx[b] - rawDiscPx[a]);
    const slotPerm = bigMiddleOrder(sortedIdx.length);
    this.starMembers     = slotPerm.map(p => cluster.members[sortedIdx[p]]);
    this.starSlotDiscPx  = slotPerm.map(p => rawDiscPx[sortedIdx[p]]);

    // Build one mesh per star. Geometry is sized to the star's natural
    // diameter (before any width-fit scaling); layout() rebuilds it if
    // a different size is needed. Initial position is (0, 0); resize
    // fills it in.
    this.starMembers.forEach((starIdx, slot) => {
      const s = STARS[starIdx];
      const col = CLASS_COLOR[s.cls] ?? CLASS_COLOR.M;
      const d = this.starSlotDiscPx[slot];
      const material = makeStarMeshMaterial();
      material.uniforms.uColor.value.setRGB(col.r, col.g, col.b);
      material.uniforms.uRadius.value = d / 2;
      const geometry = new PlaneGeometry(d, d);
      const mesh = new Mesh(geometry, material);
      // Hidden until first layout() places it; avoids a one-frame
      // flash at the origin.
      mesh.visible = false;
      scene.add(mesh);
      this.starDiscs.push({ mesh, geometry, material, currentDiam: d });
    });
  }

  layout(bufferW: number, bufferH: number): void {
    const N = this.starMembers.length;
    if (N === 0) return;

    const availW = bufferW - 2 * sizes.edgePad;
    const maxDiscPx = Math.max(...this.starSlotDiscPx);
    let gap = N > 1 ? maxDiscPx * STAR_HORIZ_GAP_FACTOR : 0;
    let totalW = sumOf(this.starSlotDiscPx) + (N - 1) * gap;

    // Width-fit: shrink gap first (down to MIN_STAR_GAP), then scale all
    // disc sizes proportionally if even the minimum-gap row would
    // overflow. The proportional scale preserves within-row size ratios.
    let discScale = 1;
    if (totalW > availW && N > 1) {
      const fixed = sumOf(this.starSlotDiscPx);
      const minTotal = fixed + (N - 1) * MIN_STAR_GAP;
      if (minTotal <= availW) {
        gap = (availW - fixed) / (N - 1);
        totalW = availW;
      } else {
        const targetFixed = availW - (N - 1) * MIN_STAR_GAP;
        discScale = targetFixed / Math.max(fixed, 1);
        gap = MIN_STAR_GAP;
        totalW = targetFixed + (N - 1) * MIN_STAR_GAP;
      }
    }

    const startX = (bufferW - totalW) / 2;
    let cursor = startX;
    for (let slot = 0; slot < N; slot++) {
      const d = Math.max(1, Math.round(this.starSlotDiscPx[slot] * discScale));
      const r = d / 2;
      const cxTarget = cursor + r;
      // Star center sits above the buffer top by STAR_OFFSCREEN_FRAC × r,
      // so the disc reads as "huge body, mostly hidden". Mesh path makes
      // this safe; GL_POINTS would discard the off-edge vertex.
      const cyTarget = bufferH + r * STAR_OFFSCREEN_FRAC;

      // Parity-aware snap for pixel-perfect rasterization: even diameter
      // → center on integer (pixel boundary), odd diameter → center on
      // integer+0.5 (pixel center). Same algorithm as the GL_POINTS
      // shader's vertex snap, just CPU-side now.
      const oddOff = (d & 1) * 0.5;
      const cx = Math.floor(cxTarget - oddOff + 0.5) + oddOff;
      const cy = Math.floor(cyTarget - oddOff + 0.5) + oddOff;

      const disc = this.starDiscs[slot];
      // Rebuild the plane geometry only when diameter actually changed;
      // a resize that doesn't change layout leaves all geometries intact.
      if (disc.currentDiam !== d) {
        disc.geometry.dispose();
        disc.geometry = new PlaneGeometry(d, d);
        disc.mesh.geometry = disc.geometry;
        disc.material.uniforms.uRadius.value = r;
        disc.currentDiam = d;
      }
      disc.mesh.position.set(cx, cy, 0);
      (disc.material.uniforms.uCenter.value as Vector2).set(cx, cy);
      disc.mesh.visible = true;

      cursor += d + gap;
    }
  }

  pickAt(x: number, y: number): BodyPick | null {
    for (let slot = 0; slot < this.starDiscs.length; slot++) {
      const disc = this.starDiscs[slot];
      const cx = disc.mesh.position.x;
      const cy = disc.mesh.position.y;
      const r = disc.currentDiam / 2;
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) {
        return { kind: 'star', starIdx: this.starMembers[slot] };
      }
    }
    return null;
  }

  setHovered(pick: BodyPick, value: 0 | 1): void {
    if (pick.kind !== 'star') return;
    const slot = this.starMembers.indexOf(pick.starIdx);
    if (slot < 0) return;
    this.starDiscs[slot].material.uniforms.uHovered.value = value;
  }

  dispose(): void {
    for (const disc of this.starDiscs) {
      disc.geometry.dispose();
      disc.material.dispose();
    }
  }
}
