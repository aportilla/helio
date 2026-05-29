// Shared frustum-culling opt-out for the system-diagram pools.
//
// Three.js computes an object's bounding sphere from its initial vertex
// positions and never recomputes it when those positions change. Every
// pool here builds with positions zeroed (or at construction-time
// coords) and rewrites them in a later layout/resize pass, so the cached
// sphere goes stale and Three.js would eventually cull a pool whose
// vertices have shifted outside their original bounds. Disabling frustum
// culling sidesteps the stale sphere; per-vertex GPU clipping still
// discards anything genuinely off-screen.

import type { Object3D } from 'three';

export function disableCulling(obj: Object3D): void {
  obj.frustumCulled = false;
}
