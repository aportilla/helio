import { Color, ShaderMaterial, Vector2, Vector3 } from 'three';
import { PIVOT_FADE_NEAR, PIVOT_FADE_FAR } from './cluster-fade';

// ─── Stars shader style constants ──────────────────────────────────────────
// Tuning knobs hoisted out of the raw shader source so they sit at the top
// of the file and can be adjusted without touching glsl strings. Each one
// is interpolated into the vertex shaders below via `${glsl(NAME)}`.

// Depth-attenuation anchor distance (perspective stars shader). A star at
// this view-space distance renders at its per-class table size; closer
// enlarges proportionally, farther shrinks. Decoupled from
// DEFAULT_VIEW.distance so framing can be tweaked without rescaling discs.
const REF_DIST = 50;

// Floor for the local-focus dim ramp. Stars outside the pivot bubble fade
// toward this brightness multiplier (color × FADE_MIN — not alpha, since
// stars render opaque for correct occlusion). Low enough that distant
// stars recede into a dim backdrop, high enough to stay just legible.
const FADE_MIN = 0.1;

// Cube-root compression on the close-up side of the depth-attenuation
// curve (rawScale > 1). Per-class size ratio is preserved (any
// positive-exponent pow is monotonic) but absolute growth is sharply
// tamed: at orbit 5 ly a focused star is ~2.15x table size instead of
// ~10x. Smaller exponent = flatter close-up; larger = more growth. The
// zoom-out branch (rawScale ≤ 1) stays linear so distant fields shrink
// at the natural rate.
const CLOSE_UP_EXPONENT = 1 / 3;

// Global star-size divisor. Raise to shrink every disc, lower to enlarge.
// uPxScale is the renderer's pixel-density signal; 800 is the empirically
// tuned reference that makes the per-class table sizes (data/stars.ts)
// look right at DEFAULT_VIEW.distance.
const PX_SCALE_DIVISOR = 800;

// Minimum integer-pixel disc size for any star. Lower-bounded so stars
// never disappear at extreme zoom-out. The upper end is intentionally
// unclamped — a cap would collapse the relative size ratios between
// classes O/B/A/F/G/K/M/BD/WD once the largest hit the ceiling.
const MIN_STAR_PX = 2;

// Rasterizer padding around the integer-pixel disc, shared by both the
// perspective and flat stars shaders. Adding +2 (preserving parity) keeps
// every fragment we care about safely inside the rasterized square so the
// rasterizer never has to make a tie-breaking call at the bounding-box
// edges that would drop a row/column on one side. Cost: a few extra
// discarded fragments per disc.
const RASTER_PAD = 2;

// JS number → glsl float literal. Always emits a decimal point so 50
// becomes "50.0", not the bare "50" that glsl rejects as an int literal.
const glsl = (n: number): string => Number.isInteger(n) ? n.toFixed(1) : n.toString();

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
      // All tuning constants below are hoisted JS values interpolated into
      // the shader source — see the "Stars shader style constants" block
      // at the top of materials.ts for full descriptions. PIVOT_FADE_*
      // mirrors the label + dropline fade in cluster-fade.ts so a dot and
      // its label dim in lockstep.
      const float REF_DIST        = ${glsl(REF_DIST)};
      const float FADE_MIN        = ${glsl(FADE_MIN)};
      const float PIVOT_FADE_NEAR = ${glsl(PIVOT_FADE_NEAR)};
      const float PIVOT_FADE_FAR  = ${glsl(PIVOT_FADE_FAR)};
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

        // Cube-root compression on the close-up side only (rawScale > 1)
        // so absolute growth tames sharply while the per-class ratio stays
        // intact. Linear on the zoom-out branch so distant fields shrink
        // at the natural rate. Tuning lives in CLOSE_UP_EXPONENT at the top
        // of the file.
        float rawScale = REF_DIST / dist;
        float depthScale = rawScale > 1.0 ? pow(rawScale, ${glsl(CLOSE_UP_EXPONENT)}) : rawScale;
        // Round to integer pixel count so zoom transitions step 2→3→4→5…
        // The upper end is intentionally unclamped — a cap would collapse
        // the relative-size ratios between class O/B/A/F/G/K/M/BD/WD into
        // a single flat blob whenever the camera got close enough to push
        // the largest class past the cap. The (28:22:18:14:12:10:8:6:3)
        // table ratio survives all the way to the closest zoom.
        float sz = max(aSize * (uPxScale / ${glsl(PX_SCALE_DIVISOR)}) * depthScale, ${glsl(MIN_STAR_PX)});
        sz = floor(sz + 0.5);
        // Render a slightly larger square than the actual disc and let the
        // fragment shader's discard test determine the real shape (see
        // RASTER_PAD up top for the rationale).
        gl_PointSize = sz + ${glsl(RASTER_PAD)};
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

// Flat 2D stars material — system-view variant. Strips every concept that
// only makes sense in the perspective galaxy view: depth attenuation,
// pivot-dim, selection/candidate bypass, focus-target snap. Keeps the
// pixel-crisp disc rendering: integer-pixel size, parity-aware center
// snap, fragment-shader disc discard from gl_FragCoord − vCenter.
//
// Designed to render under an OrthographicCamera at 1 unit = 1 buffer pixel
// (vertex positions are buffer-pixel coords). aSize is the per-star pxSize
// from data/stars.ts; uDiscScale is the global multiplier that takes those
// galaxy-tuned values up to system-view diagram size.
export function makeFlatStarsMaterial(initialDiscScale: number): ShaderMaterial {
  const m = new ShaderMaterial({
    uniforms: {
      uDiscScale: { value: initialDiscScale },
      uViewport:  { value: new Vector2(window.innerWidth, window.innerHeight) },
    },
    vertexShader: `
      attribute float aSize;
      attribute float aHovered;
      varying vec3 vColor;
      varying float vRadius;
      varying vec2 vCenter;
      varying float vHovered;
      uniform float uDiscScale;
      uniform vec2 uViewport;
      void main() {
        vColor = color;
        vHovered = aHovered;
        // Integer-pixel disc diameter. No depth attenuation — this is a
        // flat diagram, every star renders at its table size scaled by the
        // global knob. Floor + 0.5 → round-to-nearest.
        float sz = floor(aSize * uDiscScale + 0.5);
        // Same rasterizer padding as the perspective stars shader (see
        // RASTER_PAD at the top of materials.ts); the fragment shader's
        // discard test does the real bounding.
        gl_PointSize = sz + ${glsl(RASTER_PAD)};
        vRadius = sz * 0.5;

        // Parity-aware snap of the projected center to the pixel grid:
        // even sz → integer (pixel boundary), odd sz → integer + 0.5
        // (pixel center). Identical algorithm to the perspective stars
        // shader; under ortho the projection adds no FP noise, but the
        // parity snap is still load-bearing so disc pixels land symmetric
        // about the center.
        float oddOff = mod(sz, 2.0) * 0.5;
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec2 ndc = clip.xy / clip.w;
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
      varying float vHovered;
      void main() {
        vec2 d = gl_FragCoord.xy - vCenter;
        float r = length(d);
        if (r > vRadius) discard;
        // 1px white outline at the rim when hovered. The discard above
        // bounds the disc; this swap stamps the outermost pixel ring
        // (where r > vRadius - 1) to white so the hovered body reads
        // distinct from anything it overlaps. Same natural pixel-disc
        // ring shape as the body — no AA, no extra geometry.
        vec3 col = (vHovered > 0.5 && r > vRadius - 1.0) ? vec3(1.0) : vColor;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    vertexColors: true,
    transparent: false,
    // depthWrite intentionally true here — the system diagram threads
    // a per-vertex z based on each planet's row index so each planet's
    // stack (back-ring / back-moon / disc / front-ring / front-moon)
    // renders as a single z-layer above or below its neighbors. With
    // depthWrite off this ordering would collapse back to draw order.
    depthWrite: true,
  });
  snappedMaterials.push(m);
  return m;
}

// Blob material — flat-color triangle-mesh fill for irregular polygon
// chunks (belt + debris-ring debris). Geometry is indexed triangles
// authored CPU-side in buffer-pixel coords; the rasterizer determines
// the visible silhouette. Per-vertex color (so one pool can mix
// asteroid + ice + debris hues) and per-vertex hover flag — when set,
// the fragment shader inverts the triangle to white. Every vertex in
// one chunk shares the same hover value by construction, so the whole
// polygon highlights as a unit on hover.
//
// No pixel snapping: triangle vertices are placed at CPU-rounded
// integer pixel coords and the rasterizer handles fragment coverage
// from there. The polygon silhouette is what makes a chunk feel like
// debris rather than a sprite, so any sub-pixel edge variation reads
// as a coarse-pixel-art feature rather than noise.
export function makeBlobMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {},
    vertexShader: `
      attribute float aHovered;
      varying vec3 vColor;
      varying float vHovered;
      void main() {
        vColor = color;
        vHovered = aHovered;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vHovered;
      void main() {
        vec3 col = vHovered > 0.5 ? vec3(1.0) : vColor;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    vertexColors: true,
    transparent: false,
    // See makeFlatStarsMaterial — the system diagram uses vertex z to
    // bundle each planet's elements as one z-layer; the chunks need to
    // write depth too so adjacent planets' rings/discs occlude this
    // pool correctly.
    depthWrite: true,
  });
}

// Solid-fill mesh material for ice rings — used by the triangle-strip
// annulus halves in SystemDiagram. Flat color, no shading, no AA. The
// caller provides geometry whose vertex positions live in the host
// planet's local frame (origin at planet center, env-pixel units); the
// mesh is positioned at the planet's cx/cy.
//
// Per-mesh uHovered uniform (0 / 1) inverts the entire fill to white
// on hover. No per-vertex outline math because the geometry is a
// continuous arc rather than a sprite — a 1-px rim would need a
// second pass.
export function makeIceRingMaterial(color: Color): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uColor:   { value: new Color().copy(color) },
      uHovered: { value: 0 },
    },
    vertexShader: `
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uHovered;
      void main() {
        vec3 col = uHovered > 0.5 ? vec3(1.0) : uColor;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    transparent: false,
    // See makeFlatStarsMaterial — ice ring meshes ride the per-planet
    // z stride too. The back / front mesh pair sits at z slightly
    // bracketing the host planet's z so the planet disc paints over
    // the back half and the front half overpaints the planet.
    depthWrite: true,
  });
}

// Mesh-based pixel-disc material — same procedural circle as the flat
// stars material, but rasterized through a PlaneGeometry quad instead
// of a GL_POINTS sprite. The Mesh path lets the disc's center sit
// outside the viewport (above the top edge): triangle primitives are
// clipped per-fragment by the GPU, whereas GL_POINTS discards any
// point sprite whose vertex falls outside the clip volume — so the
// "star peeks down from above the screen" framing is only possible
// with the mesh path.
//
// Per-star uniforms: uCenter (buffer-pixel coords, parity-snapped by
// the caller), uRadius, uColor. Geometry should be a PlaneGeometry
// sized to fully enclose the disc bounding box (typically d×d where
// d = 2·radius). Caller positions the mesh at uCenter.
export function makeStarMeshMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uCenter:  { value: new Vector2() },
      uRadius:  { value: 0 },
      uColor:   { value: new Color() },
      // Hover outline toggle (0 = off, 1 = on). One material per disc, so
      // this lives as a uniform — no need for a per-vertex attribute path
      // here. Outline rings the bottom-strip of the top-clipped disc.
      uHovered: { value: 0 },
    },
    vertexShader: `
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec2 uCenter;
      uniform float uRadius;
      uniform vec3 uColor;
      uniform float uHovered;
      void main() {
        vec2 d = gl_FragCoord.xy - uCenter;
        float r = length(d);
        if (r > uRadius) discard;
        vec3 col = (uHovered > 0.5 && r > uRadius - 1.0) ? vec3(1.0) : uColor;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    transparent: false,
    depthWrite: false,
  });
}
