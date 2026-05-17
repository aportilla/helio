// System-view materials: flat 2D stars + chunk pool + ice ring +
// per-mesh star disc. All four are designed to render under an
// OrthographicCamera at 1 unit = 1 buffer pixel (see SystemDiagram in
// scene/system-diagram/). No depth attenuation, no pivot dim — the
// system view is a static screen layout, not a navigable 3D space.

import { Color, ShaderMaterial, Vector2 } from 'three';
import { glsl, RASTER_PAD, snappedMaterials } from './shared';

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
        // RASTER_PAD in shared.ts); the fragment shader's discard test
        // does the real bounding.
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
    // See makeFlatStarsMaterial — ring meshes ride the per-planet z
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
