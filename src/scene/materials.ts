import { Color, ShaderMaterial, Vector2 } from 'three';

// Tracked so resize() can push new viewport size into all snapped-line mats.
const snappedMaterials: ShaderMaterial[] = [];

export interface SnappedLineOptions {
  color: number;
  opacity?: number;
  dashPx?: number;
  gapPx?: number;
}

// Pixel-snapped line material: rounds each vertex's projected position to the
// nearest integer screen pixel before rasterization. Eliminates sub-pixel
// shimmer on thin lines that would otherwise fight the depth-based opacity
// cue. The dashed variant patterns in pixel space using snapped Y, so dashes
// stay aligned with the pixel grid.
export function snappedLineMat(opts: SnappedLineOptions): ShaderMaterial {
  const isDashed = (opts.dashPx ?? 0) > 0;
  const m = new ShaderMaterial({
    defines: isDashed ? { USE_DASH: '' } : {},
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
      void main() {
        // Dash pattern phased from each line's anchor on the galactic plane,
        // not a global screen Y — otherwise all droplines share the same
        // horizontal dash rows and create faint banding across the field.
        if (mod(vScreenPx.y - vAnchorScreenY, uDashPx + uGapPx) > uDashPx) discard;
        gl_FragColor = vec4(uColor, uOpacity);
      }
      #else
      void main() { gl_FragColor = vec4(uColor, uOpacity); }
      #endif
    `,
    transparent: true,
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
  return new ShaderMaterial({
    uniforms: {
      uPxScale: { value: initialPxScale },
    },
    vertexShader: `
      attribute float aSize;
      varying vec3 vColor;
      varying float vRadius;
      uniform float uPxScale;
      void main() {
        vColor = color;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        // Round size to the nearest EVEN integer pixel count. An even-sized
        // sprite has the same number of pixel-rows above and below center,
        // guaranteeing the disc is symmetrical. Odd sizes lean by 1px.
        float sz = clamp(aSize * (uPxScale / 280.0) * 2.2, 2.0, 28.0);
        sz = floor(sz * 0.5 + 0.5) * 2.0;
        gl_PointSize = sz;
        vRadius = sz * 0.5;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vRadius;
      void main() {
        // Pixel offset from sprite center, snapped to integer centers so
        // the disc has hard stair-stepped edges (no AA fringe).
        vec2 px = floor((gl_PointCoord - 0.5) * (vRadius * 2.0)) + 0.5;
        if (length(px) > vRadius - 0.5) discard;
        gl_FragColor = vec4(vColor, 1.0);
      }
    `,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
  });
}
