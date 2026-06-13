// Planet-shader warming. Entering the system view builds three planet-material
// program variants — disc, halo (PlanetsLayer's split passes) and the moon
// 'all' single pass — and the first render of each pays a synchronous GLSL
// compile/link stall on the "View System" click frame. Worse, it recurs on
// every entry: SystemScene.dispose() disposes those materials, and when a
// program's last referencing material is gone Three.js frees the GL program,
// so the next entry recompiles from scratch.
//
// warmPlanetShaders fixes both halves during galaxy-view idle:
//   - compile: renderer.compile() on a throwaway scene compiles + links the
//     three variants now, off the click frame.
//   - retain: the returned materials are held for the app's life (by
//     AppController), so each variant's program keeps a ref-count ≥ 1 even
//     after a SystemScene round-trip disposes its own copy — the program is
//     reused (cache key matches: identical custom shader source + defines),
//     so no entry ever recompiles.
//
// These materials are never rendered, so we drop them from the snapped-viewport
// registry makePlanetMaterial enrols them in (they don't want per-resize
// uniform writes; the refs below are all that's needed to pin the programs).
//
// Best-effort by contract: the caller swallows any failure. The worst case is
// a no-op — entry then pays the original un-warmed compile, exactly as before —
// so this can never regress correctness, only fail to help.

import {
  BufferGeometry, Camera, Float32BufferAttribute, Points, Scene, ShaderMaterial, WebGLRenderer,
} from 'three';
import { makePlanetMaterial, unregisterSnappedMaterial } from './materials';

export function warmPlanetShaders(renderer: WebGLRenderer): ShaderMaterial[] {
  const variants = [
    makePlanetMaterial(1.0, 'disc'),
    makePlanetMaterial(1.0, 'halo'),
    makePlanetMaterial(1.0, 'all'),
  ];
  const scene = new Scene();
  // A single-vertex position buffer is enough — compile() only compiles/links
  // the program (it never draws), so the shader's other custom attributes can
  // be absent without a warning.
  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3));
  for (const m of variants) scene.add(new Points(geom, m));
  renderer.compile(scene, new Camera());
  geom.dispose();
  for (const m of variants) unregisterSnappedMaterial(m);
  return variants;
}
