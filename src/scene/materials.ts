import { Color, ShaderMaterial, Vector2 } from 'three';

// Tracked so resize() can push new viewport size into all snapped-line mats.
const snappedMaterials: ShaderMaterial[] = [];
// Dashed subset — separate list so the scene can drive a per-frame pattern
// scale for them without touching solid lines or the stars material.
const dashedMaterials: ShaderMaterial[] = [];

export interface SnappedLineOptions {
  color: number;
  opacity?: number;
  dashPx?: number;
  gapPx?: number;
  // Render with blending disabled. Coincident lines (e.g. binary star
  // droplines) then render at exactly uColor instead of stacking alpha and
  // appearing brighter than singles. Default false (transparent).
  opaque?: boolean;
}

// Pixel-snapped line material: rounds each vertex's projected position to the
// nearest integer screen pixel before rasterization. Eliminates sub-pixel
// shimmer on thin lines that would otherwise fight the depth-based opacity
// cue. The dashed variant patterns in pixel space using snapped Y, so dashes
// stay aligned with the pixel grid.
export function snappedLineMat(opts: SnappedLineOptions): ShaderMaterial {
  const isDashed = (opts.dashPx ?? 0) > 0;
  const isOpaque = opts.opaque === true;
  const defines: Record<string, string> = {};
  if (isDashed) defines.USE_DASH = '';
  if (isOpaque) defines.OPAQUE = '';
  const m = new ShaderMaterial({
    defines,
    uniforms: {
      uColor:        { value: new Color(opts.color) },
      uOpacity:      { value: opts.opacity ?? 1.0 },
      uViewport:     { value: new Vector2(window.innerWidth, window.innerHeight) },
      uDashPx:       { value: opts.dashPx ?? 1.0 },
      uGapPx:        { value: opts.gapPx ?? 4.0 },
      // Multiplier on uGapPx, driven from the scene tick. >1 when zoomed in
      // so the gap grows in screen pixels — keeping the count of dashes
      // along a dropline roughly constant as the line lengthens on screen.
      uPatternScale: { value: 1.0 },
    },
    vertexShader: `
      uniform vec2 uViewport;
      #ifdef USE_DASH
      varying vec2 vScreenPx;
      varying float vAnchorScreenY;
      #endif
      void main() {
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec2 ndc = clip.xy / clip.w;
        vec2 px  = floor((ndc * 0.5 + 0.5) * uViewport + 0.5);
        ndc = (px / uViewport) * 2.0 - 1.0;
        gl_Position = vec4(ndc * clip.w, clip.z, clip.w);
        #ifdef USE_DASH
        vScreenPx = px;
        // Project the line's anchor (z=0 of this segment) so the dash phase
        // is relative to each line's own pin point on the galactic plane.
        // Both vertices of a dropline share x/y, so this evaluates the same
        // for both endpoints — interpolates as a constant along the line.
        vec4 aClip = projectionMatrix * modelViewMatrix * vec4(position.x, position.y, 0.0, 1.0);
        vAnchorScreenY = floor((aClip.y / aClip.w * 0.5 + 0.5) * uViewport.y + 0.5);
        #endif
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      #ifdef USE_DASH
      uniform float uDashPx;
      uniform float uGapPx;
      uniform float uPatternScale;
      varying vec2 vScreenPx;
      varying float vAnchorScreenY;
      #endif
      void main() {
        #ifdef USE_DASH
        // Dash pattern phased from each line's anchor on the galactic plane,
        // not a global screen Y — otherwise all droplines share the same
        // horizontal dash rows and create faint banding across the field.
        // Gap is scaled by uPatternScale (driven by zoom in scene.tick) so
        // that the count of dashes along a dropline stays roughly constant
        // regardless of how much screen space the line covers.
        if (mod(vScreenPx.y - vAnchorScreenY, uDashPx + uGapPx * uPatternScale) > uDashPx) discard;
        #endif
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
  if (isDashed) dashedMaterials.push(m);
  return m;
}

export function setSnappedLineViewport(w: number, h: number): void {
  for (const m of snappedMaterials) m.uniforms.uViewport.value.set(w, h);
}

export function setDashPatternScale(scale: number): void {
  for (const m of dashedMaterials) m.uniforms.uPatternScale.value = scale;
}

// Procedural circle in the fragment shader — no texture sampling, no AA
// fringe. Per-star color from spectral class via vertex color; per-star
// size via aSize attribute so brighter classes are bigger than dwarfs.
//
// Under perspective, size is depth-attenuated: a star at REF_DIST renders at
// its table size; closer stars enlarge proportionally, farther stars shrink.
// REF_DIST = DEFAULT_VIEW.distance (50) so when focused on a star at the
// orbit center, that star renders at exactly its table size.
export function makeStarsMaterial(initialPxScale: number): ShaderMaterial {
  const m = new ShaderMaterial({
    uniforms: {
      uPxScale: { value: initialPxScale },
      uViewport: { value: new Vector2(window.innerWidth, window.innerHeight) },
    },
    vertexShader: `
      attribute float aSize;
      varying vec3 vColor;
      varying float vRadius;
      varying vec2 vCenter;
      uniform float uPxScale;
      uniform vec2 uViewport;
      const float REF_DIST = 50.0;
      void main() {
        vColor = color;
        // Depth-attenuate by view-space distance so closer stars render
        // larger and farther stars smaller — the depth cue that perspective
        // earns us. View-space z is negative looking down -Z; flip and floor
        // so a star sitting on top of the camera doesn't blow up to inf.
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        float dist = max(-mvPos.z, 0.5);
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
        float sz = max(aSize * (uPxScale / 600.0) * depthScale, 2.0);
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
        gl_FragColor = vec4(vColor, 1.0);
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
