// Materials barrel — consumers import from '.../materials' and get
// whichever symbols they need. Galaxy-view shaders live in ./galaxy.ts,
// system-view shaders in ./system.ts, shared infrastructure (registry
// + glsl helper) in ./shared.ts.

export { setSnappedLineViewport } from './shared';
export {
  makeStarsMaterial,
  snappedDotsMat,
  snappedLineMat,
  type SnappedLineOptions,
} from './galaxy';
export {
  makeBlobMaterial,
  makeFlatStarsMaterial,
  makeIceRingMaterial,
  makeStarMeshMaterial,
} from './system';
