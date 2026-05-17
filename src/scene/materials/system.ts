// System-view materials: flat 2D stars + chunk pool + ice ring +
// per-mesh star disc. All four are designed to render under an
// OrthographicCamera at 1 unit = 1 buffer pixel (see SystemDiagram in
// scene/system-diagram/). No depth attenuation, no pivot dim — the
// system view is a static screen layout, not a navigable 3D space.

import { Color, ShaderMaterial, Vector2 } from 'three';
import { glsl, RASTER_PAD, snappedMaterials } from './shared';

// Planet + moon disc material. Renders a pixel-crisp disc whose interior
// is one of two procedural textures:
//
//   - **Surface mode (aMode = 0)** — worley/voronoi cell texture: the
//     disc is divided into SURFACE_PATCH_PX-wide cells, each with a
//     jittered center seeded per-body; every fragment picks a palette
//     entry by hashing its nearest cell. Gives organic lumpy ground
//     cover rather than per-pixel speckle. Driven CPU-side by the
//     world-class color + 2 dominant resources from the body's resource
//     grid.
//   - **Banded mode (aMode = 1)** — latitude-quantized strips, each band
//     picking a palette entry by a per-band hash. Driven by the top 3
//     atmospheric gases. Used for gas/ice giants and Venus-class worlds
//     where the atmosphere visually replaces the surface.
//
// Per-vertex attributes drive both modes:
//   aPalette0/1/2  — three RGB palette entries
//   aWeights       — three [0..1] weights (sum to ~1; the picker treats
//                    zero-weight slots as ineligible)
//   aMode          — 0 = surface, 1 = banded
//   aSeed          — per-body [0..1) random; salts every hash so two
//                    planets with the same palette still texture differently
//
// Pixel-crisp constraints (see README §Pixel-perfect rendering):
//   - The disc still does parity-aware center snap so `gl_FragCoord -
//     vCenter` lands at symmetric pixel offsets.
//   - Cell boundaries are computed from integer pixel offsets, so each
//     rendered pixel resolves to exactly one cell — the texture is
//     integer-pixel grained.
//   - No AA, no gradients, no inter-palette blending.
//
// Designed for an OrthographicCamera at 1 unit = 1 buffer pixel (vertex
// positions are buffer-pixel coords). `aSize` is the per-body disc
// diameter; `uDiscScale` is a global multiplier (planets + moons pass 1.0,
// the diagram already bakes its own sizing).
export function makePlanetMaterial(initialDiscScale: number): ShaderMaterial {
  const m = new ShaderMaterial({
    uniforms: {
      uDiscScale: { value: initialDiscScale },
      uViewport:  { value: new Vector2(window.innerWidth, window.innerHeight) },
    },
    vertexShader: `
      attribute float aSize;
      attribute float aHovered;
      attribute vec3  aPalette0;
      attribute vec3  aPalette1;
      attribute vec3  aPalette2;
      attribute vec3  aWeights;
      attribute float aMode;
      attribute float aSeed;
      varying float vRadius;
      varying vec2  vCenter;
      varying float vHovered;
      varying vec3  vPalette0;
      varying vec3  vPalette1;
      varying vec3  vPalette2;
      varying vec3  vWeights;
      varying float vMode;
      varying float vSeed;
      uniform float uDiscScale;
      uniform vec2  uViewport;
      void main() {
        vHovered  = aHovered;
        vPalette0 = aPalette0;
        vPalette1 = aPalette1;
        vPalette2 = aPalette2;
        vWeights  = aWeights;
        vMode     = aMode;
        vSeed     = aSeed;

        // Integer-pixel disc diameter. Floor + 0.5 → round-to-nearest.
        float sz = floor(aSize * uDiscScale + 0.5);
        // Rasterizer padding (see RASTER_PAD in shared.ts); the fragment
        // discard test does the real bounding.
        gl_PointSize = sz + ${glsl(RASTER_PAD)};
        vRadius = sz * 0.5;

        // Parity-aware snap of the projected center to the pixel grid:
        // even sz → integer (pixel boundary), odd sz → integer + 0.5
        // (pixel center). Load-bearing for symmetric disc rasterization
        // under the gl_FragCoord − vCenter offset path.
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
      varying float vRadius;
      varying vec2  vCenter;
      varying float vHovered;
      varying vec3  vPalette0;
      varying vec3  vPalette1;
      varying vec3  vPalette2;
      varying vec3  vWeights;
      varying float vMode;
      varying float vSeed;

      // Bands across the disc in banded mode. Disc lat spans [-1, 1] so
      // floor(lat * BAND_COUNT) yields 2*BAND_COUNT distinct strips —
      // BAND_COUNT=3 → 6 visible bands, ~1/6 of disc diameter each
      // (≈7 px on a 40 px disc, ≈20 px on a 120 px gas giant).
      const float BAND_COUNT = 3.0;

      // Surface-mode worley cell pitch in buffer pixels. A 60-px planet
      // disc gets ~15 cells across; jittered cell centers make the
      // patch silhouettes non-grid-aligned, so the ground reads as
      // organic lumps rather than rectangular tiles.
      const float SURFACE_PATCH_PX = 4.0;

      float hash11(float x) {
        return fract(sin(x * 12.9898 + 78.233) * 43758.5453);
      }
      float hash21(vec2 p) {
        return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
      }

      // Pick one of three palette entries by a 0..1 hash, weighted by
      // vWeights. Skips zero-weight slots automatically. Defensive
      // fallback: weights summing to zero → palette0 (the world-class
      // base color is always plumbed there).
      vec3 pickFromPalette(float h) {
        float w = vWeights.x + vWeights.y + vWeights.z;
        if (w <= 0.0) return vPalette0;
        float t = h * w;
        if (t < vWeights.x) return vPalette0;
        if (t < vWeights.x + vWeights.y) return vPalette1;
        return vPalette2;
      }

      void main() {
        vec2 d = gl_FragCoord.xy - vCenter;
        float r = length(d);
        if (r > vRadius) discard;

        vec3 col;
        if (vMode < 0.5) {
          // Surface — worley/voronoi cells. Divide the disc into
          // SURFACE_PATCH_PX-wide cells, jitter each cell's center
          // per-body, and pick the palette entry for the nearest cell.
          // Salted by vSeed so two same-palette planets get distinct
          // patch layouts. 9 candidate cells (3x3 neighborhood) is the
          // minimum needed for correct nearest-cell when centers are
          // jittered within the full unit cell.
          vec2 cellPos = d / SURFACE_PATCH_PX;
          vec2 cellId  = floor(cellPos);
          vec2 cellFrac = cellPos - cellId;
          float minDist2 = 1e9;
          vec2  winnerCell = cellId;
          for (int dx = -1; dx <= 1; dx++) {
            for (int dy = -1; dy <= 1; dy++) {
              vec2 off = vec2(float(dx), float(dy));
              vec2 nCell = cellId + off;
              vec2 jitter = vec2(
                hash21(nCell + vec2(vSeed * 13.0,  vSeed * 19.0)),
                hash21(nCell + vec2(vSeed * 23.0,  vSeed * 29.0))
              );
              vec2 nCenter = off + jitter;
              vec2 diff = nCenter - cellFrac;
              float d2 = dot(diff, diff);
              if (d2 < minDist2) {
                minDist2 = d2;
                winnerCell = nCell;
              }
            }
          }
          float h = hash21(winnerCell + vec2(vSeed * 1009.0, vSeed * 2017.0));
          col = pickFromPalette(h);
        } else {
          // Banded atmosphere — quantize latitude into discrete strips,
          // each picking one palette entry by a per-band hash. The seed
          // offset shifts band boundaries so two same-class giants don't
          // comb-align.
          float lat = d.y / vRadius;
          float band = floor(lat * BAND_COUNT + vSeed * BAND_COUNT);
          float h = hash11(band + vSeed * 41.0);
          col = pickFromPalette(h);
        }

        // 1-px hover rim — same as the previous flat-disc material. The
        // discard above bounds the disc; this swap stamps the outermost
        // pixel ring (where r > vRadius - 1) to white when hovered, so
        // the body reads distinct from anything it overlaps.
        if (vHovered > 0.5 && r > vRadius - 1.0) col = vec3(1.0);

        gl_FragColor = vec4(col, 1.0);
      }
    `,
    transparent: false,
    // depthWrite intentionally true — the system diagram threads a
    // per-vertex z based on each planet's row index so each planet's
    // stack (back-ring / back-moon / disc / front-ring / front-moon)
    // renders as a single z-layer above or below its neighbors.
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
    // See makePlanetMaterial — the system diagram uses vertex z to
    // bundle each planet's elements as one z-layer; the chunks need to
    // write depth too so adjacent planets' rings/discs occlude this
    // pool correctly.
    depthWrite: true,
  });
}

// Solid-fill mesh material for planetary rings — used by the
// triangle-strip annulus halves in SystemDiagram. Flat color, no
// shading, no AA. The caller provides geometry whose vertex positions
// live in the host planet's local frame (origin at planet center,
// env-pixel units); the mesh is positioned at the planet's cx/cy.
//
// The caller pre-lerps `color` from the icy/dusty palette endpoints
// based on the ring's resource mix (see bodyIcyness in data/stars.ts).
// `alpha` is similarly lerped — icy rings paint opaque (Saturn-class
// bright band) while dusty rings paint translucent (Uranus/Neptune-
// class faint dust). When alpha < 1 the material flips to transparent
// + depthWrite=false so the stars and background show through.
//
// Per-mesh uHovered uniform (0 / 1) inverts the entire fill to white
// on hover. No per-vertex outline math because the geometry is a
// continuous arc rather than a sprite — a 1-px rim would need a
// second pass.
export function makeRingMaterial(color: Color, alpha: number): ShaderMaterial {
  const transparent = alpha < 1;
  return new ShaderMaterial({
    uniforms: {
      uColor:   { value: new Color().copy(color) },
      uAlpha:   { value: alpha },
      uHovered: { value: 0 },
    },
    vertexShader: `
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uAlpha;
      uniform float uHovered;
      void main() {
        vec3 col = uHovered > 0.5 ? vec3(1.0) : uColor;
        float a  = uHovered > 0.5 ? 1.0 : uAlpha;
        gl_FragColor = vec4(col, a);
      }
    `,
    transparent,
    // See makePlanetMaterial — ring meshes ride the per-planet z
    // stride too. The back / front mesh pair sits at z slightly
    // bracketing the host planet's z so the planet disc paints over
    // the back half and the front half overpaints the planet.
    // depthWrite stays off for translucent rings so the background
    // shows through their gaps rather than masking it.
    depthWrite: !transparent,
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
