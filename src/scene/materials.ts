import { Color, ShaderMaterial, Vector2 } from 'three';

// Tracked so resize() can push new viewport size into all snapped-line mats.
const snappedMaterials: ShaderMaterial[] = [];

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
      uColor:    { value: new Color(opts.color) },
      uOpacity:  { value: opts.opacity ?? 1.0 },
      uViewport: { value: new Vector2(window.innerWidth, window.innerHeight) },
      uDashPx:   { value: opts.dashPx ?? 1.0 },
      uGapPx:    { value: opts.gapPx ?? 4.0 },
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
      varying vec2 vScreenPx;
      varying float vAnchorScreenY;
      #endif
      void main() {
        #ifdef USE_DASH
        // Dash pattern phased from each line's anchor on the galactic plane,
        // not a global screen Y — otherwise all droplines share the same
        // horizontal dash rows and create faint banding across the field.
        if (mod(vScreenPx.y - vAnchorScreenY, uDashPx + uGapPx) > uDashPx) discard;
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
  return m;
}

export function setSnappedLineViewport(w: number, h: number): void {
  for (const m of snappedMaterials) m.uniforms.uViewport.value.set(w, h);
}

// Procedural circle in the fragment shader — no texture sampling, no AA
// fringe. Per-star color from spectral class via vertex color; per-star
// size via aSize attribute so brighter classes are bigger than dwarfs.
export function makeStarsMaterial(initialPxScale: number): ShaderMaterial {
  const m = new ShaderMaterial({
    uniforms: {
      uPxScale: { value: initialPxScale },
      // 1.0 at default zoom, drops linearly as the camera zooms out so stars
      // shrink with the widening world view. Capped at 1 in JS so zooming in
      // past the default doesn't blow stars up — the current default size is
      // the visual maximum.
      uZoomScale: { value: 1.0 },
      uViewport: { value: new Vector2(window.innerWidth, window.innerHeight) },
    },
    vertexShader: `
      attribute float aSize;
      varying vec3 vColor;
      varying float vRadius;
      uniform float uPxScale;
      uniform float uZoomScale;
      uniform vec2 uViewport;
      void main() {
        vColor = color;
        // Round size to the nearest INTEGER pixel count so zoom transitions
        // step 2→3→4→5… instead of 2→4→6 (the previous even-only rounding
        // skipped every other size). aSize is the per-class pixel size at
        // the reference resolution (uPxScale = 600, ≈ a 1200-px-tall render
        // buffer); uPxScale ratio scales discs modestly with viewport size,
        // and uZoomScale shrinks them on zoom-out (capped at 1 in JS).
        // Raise the divisor to shrink all stars globally.
        float sz = clamp(aSize * (uPxScale / 600.0) * uZoomScale, 2.0, 28.0);
        sz = floor(sz + 0.5);
        gl_PointSize = sz;
        vRadius = sz * 0.5;

        // Snap the projected center to the pixel grid. Even-sized sprites
        // must center on a pixel BOUNDARY (integer screen coord) so the N/2
        // rows on each side cover symmetric pixels; odd-sized sprites must
        // center on a pixel CENTER (half-integer screen coord) so the
        // (N-1)/2 rows on each side plus the central row are symmetric.
        // Mismatching parity-to-snap is the failure mode the previous
        // even-only rule worked around — gl.POINTS rasterizers handle the
        // ambiguous case inconsistently and drop a row of pixels on one
        // edge. Without snapping at all, points whose projected center
        // lands at the wrong sub-pixel offset (notably the Sun at world
        // origin when the camera target is also the Sun) get asymmetric
        // coverage and read as half-discs.
        float oddOff = mod(sz, 2.0) * 0.5;
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec2 ndc = clip.xy / clip.w;
        vec2 fp = (ndc * 0.5 + 0.5) * uViewport;
        vec2 px = floor(fp - oddOff + 0.5) + oddOff;
        ndc = (px / uViewport) * 2.0 - 1.0;
        gl_Position = vec4(ndc * clip.w, clip.z, clip.w);
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vRadius;
      void main() {
        // Pixel-center offset from sprite center, in pixel units. For even
        // sizes pixel centers sit at half-integer offsets (±0.5, ±1.5, …);
        // for odd sizes at integer offsets (0, ±1, ±2, …). Snap to whichever
        // grid this sprite uses so the discard test compares pixel centers
        // to the radius — gives hard stair-stepped edges with no AA fringe.
        float odd = mod(vRadius * 2.0, 2.0);
        vec2 d = (gl_PointCoord - 0.5) * (vRadius * 2.0);
        vec2 px = mix(floor(d) + 0.5, floor(d + 0.5), odd);
        // True Euclidean disc test: keep pixels whose center is within
        // vRadius of the sprite center. This gives the natural pixel-art
        // progression — sizes 1/2/3 stay full squares (every corner sits
        // inside the circle's bounding radius), size 4 starts cutting
        // corners (12 px), 5 → 21 px, and on up. Don't subtract a fudge
        // factor: the previous (vRadius - 0.5) rule chewed extra pixels off
        // small sizes, collapsing size 4 to a 2x2 inner block and size 3
        // to a 5-px plus.
        if (length(px) > vRadius) discard;
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
