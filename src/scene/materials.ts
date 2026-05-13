import { Color, ShaderMaterial, Vector2, Vector3 } from 'three';
import { PIVOT_FADE_NEAR, PIVOT_FADE_FAR } from './cluster-fade';

// Tracked so resize() can push new viewport size into all snapped-line mats.
const snappedMaterials: ShaderMaterial[] = [];

export interface SnappedLineOptions {
  color: number;
  opacity?: number;
  // Render with blending disabled. Coincident lines (e.g. binary star
  // droplines) then render at exactly uColor instead of stacking alpha and
  // appearing brighter than singles. Default false (transparent).
  opaque?: boolean;
}

// Pixel-snapped line material: rounds each vertex's projected position to the
// nearest integer screen pixel before rasterization. Eliminates sub-pixel
// shimmer on thin lines that would otherwise fight the depth-based opacity
// cue. Dropline dashes are baked into geometry as separate short segments
// (see droplines.ts), so this material has no dash-specific path — every
// segment renders as a snapped solid line.
export function snappedLineMat(opts: SnappedLineOptions): ShaderMaterial {
  const isOpaque = opts.opaque === true;
  const defines: Record<string, string> = {};
  if (isOpaque) defines.OPAQUE = '';
  const m = new ShaderMaterial({
    defines,
    uniforms: {
      uColor:    { value: new Color(opts.color) },
      uOpacity:  { value: opts.opacity ?? 1.0 },
      uViewport: { value: new Vector2(window.innerWidth, window.innerHeight) },
    },
    vertexShader: `
      uniform vec2 uViewport;
      void main() {
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec2 ndc = clip.xy / clip.w;
        vec2 px  = floor((ndc * 0.5 + 0.5) * uViewport + 0.5);
        ndc = (px / uViewport) * 2.0 - 1.0;
        gl_Position = vec4(ndc * clip.w, clip.z, clip.w);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      void main() {
        #ifdef OPAQUE
        gl_FragColor = vec4(uColor, 1.0);
        #else
        gl_FragColor = vec4(uColor, uOpacity);
        #endif
      }
    `,
    transparent: !isOpaque,
    depthWrite: false,
  });
  snappedMaterials.push(m);
  return m;
}

export function setSnappedLineViewport(w: number, h: number): void {
  for (const m of snappedMaterials) m.uniforms.uViewport.value.set(w, h);
}

// 1-pixel pixel-snapped points. Each vertex renders as exactly one buffer
// pixel by snapping the projected center to an integer + 0.5 (pixel center)
// and setting gl_PointSize = 1. Used by droplines for the dotted (far-side
// of the galactic plane) variant — far simpler than baking dash segments
// into LineSegments geometry, since each dot is a single vertex.
export function snappedDotsMat(opts: { color: number; opacity?: number }): ShaderMaterial {
  const m = new ShaderMaterial({
    uniforms: {
      uColor:    { value: new Color(opts.color) },
      uOpacity:  { value: opts.opacity ?? 1.0 },
      uViewport: { value: new Vector2(window.innerWidth, window.innerHeight) },
    },
    vertexShader: `
      uniform vec2 uViewport;
      void main() {
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec2 ndc = clip.xy / clip.w;
        vec2 fp  = (ndc * 0.5 + 0.5) * uViewport;
        // Snap to pixel center (integer + 0.5) so a size-1 point covers
        // exactly one buffer pixel rather than straddling two.
        vec2 px  = floor(fp) + 0.5;
        ndc = (px / uViewport) * 2.0 - 1.0;
        gl_Position = vec4(ndc * clip.w, clip.z, clip.w);
        gl_PointSize = 1.0;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      void main() {
        gl_FragColor = vec4(uColor, uOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
  });
  // Reuse the snapped-line registry so resize() pushes the new viewport into
  // dot materials too — same uViewport uniform name.
  snappedMaterials.push(m);
  return m;
}

// Procedural circle in the fragment shader — no texture sampling, no AA
// fringe. Per-star color from spectral class via vertex color; per-star
// size via aSize attribute so brighter classes are bigger than dwarfs.
//
// Under perspective, size is depth-attenuated: a star at REF_DIST renders at
// its table size; closer stars enlarge proportionally, farther stars shrink.
// REF_DIST anchors the depth-attenuation curve to the value the per-class
// table sizes were tuned against — independent of the default orbit radius
// (which can be tweaked for framing without rescaling every disc).
export function makeStarsMaterial(initialPxScale: number): ShaderMaterial {
  const m = new ShaderMaterial({
    uniforms: {
      uPxScale: { value: initialPxScale },
      uViewport: { value: new Vector2(window.innerWidth, window.innerHeight) },
      // World position of the camera's orbit target. The vertex with this
      // exact position projects to NDC (0,0) by construction; bypassing the
      // matrix math for that one vertex kills the 1px disc twitch caused by
      // FP noise crossing the pixel-snap threshold. Set per-frame from
      // StarPoints.setFocus(). Defaults far outside the catalog so no real
      // star matches before the first frame's setFocus() runs.
      uFocusWorld: { value: new Vector3(1e9, 1e9, 1e9) },
      // Orbit pivot in world space — drives the local-focus dim ramp. Same
      // value as uFocusWorld in practice today, but kept as a separate
      // uniform because uFocusWorld doubles as the "snap-to-NDC-zero" key
      // and reusing it for the fade math would couple two unrelated
      // semantics. Updated per-frame from StarPoints.setPivot().
      uPivotWorld: { value: new Vector3() },
      // Selected / candidate cluster indices. Stars whose aClusterIdx
      // matches either bypass the dim ramp and render at full brightness —
      // mirrors the yellow-label promotion in labels.ts. -1 = none.
      uSelectedCluster:  { value: -1 },
      uCandidateCluster: { value: -1 },
      // How much of the pivot-dim effect to apply: 1.0 = full local-focus
      // dim, 0.0 = effect off (all stars at full brightness). Driven CPU-
      // side from view.distance via STAR_DIM_FULL_BELOW / STAR_DIM_OFF_ABOVE
      // in cluster-fade.ts so zooming out smoothly disables the effect.
      uDimAmount: { value: 1.0 },
    },
    vertexShader: `
      attribute float aSize;
      attribute float aClusterIdx;
      varying vec3 vColor;
      varying float vRadius;
      varying vec2 vCenter;
      varying float vBrightness;
      uniform float uPxScale;
      uniform vec2 uViewport;
      uniform vec3 uFocusWorld;
      uniform vec3 uPivotWorld;
      uniform float uSelectedCluster;
      uniform float uCandidateCluster;
      uniform float uDimAmount;
      const float REF_DIST = 50.0;
      // Pivot fade thresholds mirror the label + dropline fade in
      // cluster-fade.ts — same numbers, same semantics, so the dot dims in
      // lockstep with its label. FADE_MIN floors the dim at 0.25 so distant
      // stars stay legible as a dim backdrop rather than vanishing.
      const float PIVOT_FADE_NEAR = ${PIVOT_FADE_NEAR.toFixed(1)};
      const float PIVOT_FADE_FAR  = ${PIVOT_FADE_FAR.toFixed(1)};
      const float FADE_MIN = 0.25;
      void main() {
        vColor = color;
        // Depth-attenuate by view-space distance so closer stars render
        // larger and farther stars smaller — the depth cue that perspective
        // earns us. View-space z is negative looking down -Z; flip and floor
        // so a star sitting on top of the camera doesn't blow up to inf.
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        float dist = max(-mvPos.z, 0.5);

        // Local-focus dim: stars outside the pivot bubble fade toward
        // FADE_MIN, matching the per-cluster label fade so the dot and its
        // name dim together. The effect is scaled by uDimAmount (1=full,
        // 0=off), driven CPU-side from view.distance — when the user zooms
        // out, the whole effect disappears and every star returns to full
        // brightness. Selected and candidate cluster members bypass.
        float dPivot = length(position - uPivotWorld);
        float pivotFade = 1.0 - clamp((dPivot - PIVOT_FADE_NEAR) /
                                      (PIVOT_FADE_FAR - PIVOT_FADE_NEAR), 0.0, 1.0);
        float effPivotFade = mix(1.0, pivotFade, uDimAmount);
        float bypass = (abs(aClusterIdx - uSelectedCluster)  < 0.5 ||
                        abs(aClusterIdx - uCandidateCluster) < 0.5) ? 1.0 : 0.0;
        vBrightness = max(mix(FADE_MIN, 1.0, effPivotFade), bypass);

        // Linear growth on the close-up side (rawScale > 1) feels too eager
        // — at orbit 5 ly a focused class-G star ends up 10x its table size
        // and dominates the screen. Cube-root-compress the close-up side
        // only: the per-class ratio stays intact (any monotonic function
        // preserves ordering, and pow with a positive exponent preserves
        // the ratio shape) but absolute growth tames sharply — at orbit 5
        // a focused star is ~2.15x table size, at orbit 4 it's ~2.32x. The
        // exponent (1/3) is the tuning knob: smaller = flatter close-up,
        // larger = more growth. The zoom-out branch stays linear so distant
        // fields shrink at the natural rate.
        float rawScale = REF_DIST / dist;
        float depthScale = rawScale > 1.0 ? pow(rawScale, 1.0 / 3.0) : rawScale;
        // Round to integer pixel count so zoom transitions step 2→3→4→5…
        // Raise the divisor to shrink all stars globally. Lower-bounded at
        // 2 px so stars never disappear at extreme zoom-out, but otherwise
        // unclamped on the upper end — the previous 28-px cap collapsed the
        // relative-size ratios between class O/B/A/F/G/K/M/BD/WD into a
        // single flat blob whenever the camera got close enough to push the
        // largest class past the cap. Without an upper bound, the ratio
        // (28:22:18:14:12:10:8:6:3) survives all the way to the closest
        // possible zoom and you can see Alpha Cen A, B, and Proxima as
        // visibly different-sized discs at a 5-ly orbit.
        float sz = max(aSize * (uPxScale / 800.0) * depthScale, 2.0);
        sz = floor(sz + 0.5);
        // Render a slightly larger square than the actual disc and let the
        // fragment shader's discard test determine the real shape. Without
        // this padding, the rasterizer's fill rule at the bounding-box
        // edges can drop a row or column on the bottom/left side (visible
        // as asymmetric clipping). Adding +2 (preserving parity) keeps every
        // fragment we care about safely inside the rasterized square so the
        // rasterizer never has to make a tie-breaking call. Cost is a few
        // extra discarded fragments per disc.
        gl_PointSize = sz + 2.0;
        vRadius = sz * 0.5;

        // Parity-aware snap of the projected center to the pixel grid.
        // - even sz: pixel BOUNDARY (integer window coord) so the sz/2 rows
        //   on each side cover symmetric pixels.
        // - odd sz:  pixel CENTER (half-integer) so (sz-1)/2 rows on each
        //   side plus the central row are symmetric.
        // The snapped center is also passed to the fragment shader as
        // vCenter so it can compute exact pixel-grid offsets without
        // touching gl_PointCoord (whose sub-pixel precision is
        // implementation-defined and produces visible asymmetry on some
        // drivers when the point center sits at sub-pixel positions).
        float oddOff = mod(sz, 2.0) * 0.5;
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        // Focus-target short-circuit: the camera always lookAt's uFocusWorld,
        // so the matching vertex's true NDC is mathematically (0,0). The
        // matrix product produces (~1e-7, ~1e-7) instead, which is enough
        // noise to flip the parity-aware snap below by 1 pixel each frame
        // as yaw/pitch rotate. Substitute exact (0,0) for that vertex only.
        vec2 ndc = all(equal(position, uFocusWorld)) ? vec2(0.0) : (clip.xy / clip.w);
        vec2 fp = (ndc * 0.5 + 0.5) * uViewport;
        vec2 px = floor(fp - oddOff + 0.5) + oddOff;
        vCenter = px;
        ndc = (px / uViewport) * 2.0 - 1.0;
        gl_Position = vec4(ndc * clip.w, clip.z, clip.w);
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vRadius;
      varying vec2 vCenter;
      varying float vBrightness;
      void main() {
        // Pixel-center offset from sprite center, in window-pixel units.
        // gl_FragCoord.xy is at integer + 0.5 (each pixel's center);
        // vCenter is integer (even sz) or half-integer (odd sz), so d
        // lands at clean half-integer or integer offsets — exactly the
        // pixel-grid spacing, symmetric about both axes by construction.
        // No gl_PointCoord, no parity branch. The length test then yields
        // the natural pixel-disc progression: sizes 1/2/3 stay full squares
        // (every corner is inside the bounding radius), 4 starts cutting
        // corners (12 px), 5 → 21 px, and on up.
        vec2 d = gl_FragCoord.xy - vCenter;
        if (length(d) > vRadius) discard;
        gl_FragColor = vec4(vColor * vBrightness, 1.0);
      }
    `,
    vertexColors: true,
    // Opaque + depthWrite so closer stars properly occlude further ones.
    // Without depthWrite, stars in a single Points geometry would render in
    // attribute (catalog) order, ignoring camera-relative distance. The disc
    // shader writes alpha=1 inside and discards outside, so opaque is correct.
    transparent: false,
    depthWrite: true,
  });
  // Track in the same list as the line materials so resize() updates both
  // viewport uniforms in one call.
  snappedMaterials.push(m);
  return m;
}
