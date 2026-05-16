// Tuning knobs for the system-view diagram, hoisted out of the layer
// code so the "edit a number, reload, eyeball" loop touches one file.
// Geometry, layout, and color values live here; pure math constants
// (e.g. RING_MINOR_OVER_MAJOR) sit alongside the layout values they
// pair with.

// --- Stars row ---

// Per-star disc-diameter multiplier on top of the galaxy-tuned pxSize.
// Stars render as top-clipped half-discs hanging off the buffer top,
// so most of the disc area is off-screen — scale up generously to
// suggest "substantial body poking through".
export const DISC_SCALE = 9;

// Fraction of the disc radius pushed above the viewport top. 0 = center
// on edge (half disc visible). 0.4 = center is 40% of radius above edge,
// 30% of disc visible as a strip below the edge. Higher = stars feel
// bigger because more is "hidden up there"; ≥ 0.5 starts making small
// stars vanish entirely (visible portion < a few px).
export const STAR_OFFSCREEN_FRAC = 0.3;

// Edge-to-edge horizontal gap between adjacent stars, expressed as a
// fraction of the largest member's disc diameter. Smaller than a full-
// disc-row value would be because discs are top-clipped — they read
// smaller, so less breathing room is needed.
export const STAR_HORIZ_GAP_FACTOR = 0.3;
// Floor for the star gap when the row is width-constrained; below this
// we start scaling disc sizes down.
export const MIN_STAR_GAP = 2;

// --- Body dome ---

// Distance from the TOP of the screen to the dome's PEAK (where the
// middle planet sits). Fixed — the top of the arc stays at a constant
// gap below the stars regardless of viewport size; only the dome's
// edges move (see DOME_PEAK_*_PX below).
export const PLANET_PEAK_FROM_TOP = 120;

// Dome height — vertical drop from the peak to the edges. Scales with
// viewport area so bigger screens get a more pronounced arc; the edges
// drop lower while the peak stays anchored. Area drives the lerp
// (rather than width or height alone) because the arc reads as
// "proportional to how much real estate you have."
export const DOME_PEAK_MIN_PX = 60;
export const DOME_PEAK_MAX_PX = 120;
// Anchor points for the lerp (env-px², post-render-scale). 400k ≈ small
// laptop viewport; 2M ≈ full-HD desktop.
export const DOME_AREA_MIN = 400_000;
export const DOME_AREA_MAX = 2_000_000;

// --- Planet + moon disc sizing ---

// Planet discs sized from radiusEarth with cube-root compression. The
// real radius range across rocky-to-gas-giant is ~30× (Mercury 0.38 R⊕ →
// Jupiter 11.2 R⊕); cbrt(30) ≈ 3.1, so the rendered diameter range
// collapses to ~3× — Mercury / Mars at the floor read clearly while
// Jupiter / Saturn still feel substantial without dwarfing the row.
export const PLANET_DISC_MIN = 40;
export const PLANET_DISC_MAX = 120;
// Multiplier on cbrt(radiusEarth). 54 was picked so Earth (1.0 R⊕) lands
// near the middle of the range and Jupiter (11.2 R⊕) at ~120 px while
// Mercury (0.38 R⊕) lands near the 40 px floor — preserving the 3×
// Jupiter / Mercury ratio at the clamps.
export const PLANET_DISC_BASE = 54;

// Moon discs use the same cbrt curve as planets. The 50 px cap exceeds
// the 40 px planet floor on purpose — moons read against their parent,
// not against the smallest planet in the system, and big moons cluster
// around big planets (Ganymede / Titan orbit gas giants), so a 50 px
// moon always sits next to a 100+ px parent in practice. Floor at 10
// keeps tiny inner moons visible against a 120-px Jupiter.
export const MOON_DISC_MIN = 10;
export const MOON_DISC_MAX = 50;
// Multiplier on cbrt(radiusEarth). 67 lands Ganymede / Titan (~0.4 R⊕)
// at the 50 px cap and Luna (~0.27 R⊕) at ~43 px.
export const MOON_DISC_BASE = 67;

// Moon-center distance from parent center, expressed as an offset
// relative to parent's rim. 0 = moon centered exactly on the parent's
// rim (half the moon disc inside the parent, half outside). Positive
// pushes moons outward; negative pulls them inward.
export const MOON_EDGE_BIAS = 0;

// Per-channel lerp of moon color toward white. Same-world-class moon +
// parent would otherwise share an exact color and the moon's inner half
// would disappear into the parent at the rim overlap. Lerp toward white
// (rather than additive bump) preserves hue and won't oversaturate
// channels already near 1.
export const MOON_BRIGHTEN = 0.15;

// --- Belts ---

// Belts occupy a row slot like a planet, but render as a vertical
// column of irregular angular blobs (polygon meshes) rather than a
// single disc. Slot width is fixed (not derived from belt mass) so a
// system's row-layout math stays simple.
export const BELT_SLOT_WIDTH = 36;
// Vertical extent of a belt column, expressed as a multiple of the
// largest planet disc on the row. ~3× makes the band feel like a
// structural feature spanning a real swath of the system rather than
// a compact cluster — wide enough to read distinctly from a tightly
// packed moon system but not so tall it crashes into the stars or
// the ships area.
export const BELT_HEIGHT_FACTOR = 3.0;
// Chunk count range per belt. Smallest masses bottom out at MIN; the
// largest belts approach MAX. Log-based so a 100× mass range only
// doubles chunk count.
export const BELT_CHUNKS_MIN = 20;
export const BELT_CHUNKS_MAX = 50;
// Per-chunk polygon half-extent in env-px. A chunk's silhouette is one
// of the BLOB_SHAPES inscribed in a unit circle, scaled by this size
// and rotated by a per-chunk angle, so the visible footprint is roughly
// (2*size) × (2*size) with the polygon filling ~60% of the bbox.
export const BELT_CHUNK_SIZES = [2, 3, 4, 5, 6];

// --- Rings ---
//
// Rings render as a tilted ellipse around the host planet. Ice rings
// are solid triangle-strip annuli (back-half mesh draws before the
// planet, front-half after, so the planet disc occludes one and the
// front mesh overpaints the other); debris rings are angular-blob
// polygons scattered along the same ellipse path with the same
// back/front split. Both share the geometry constants below so a
// planet that rolls "ice" vs "debris" sits in the same physical space.

// Perspective compression: how much the ring's vertical extent is
// squished relative to its horizontal extent. 0.20 is a Saturn-like
// "looking down at it from above" angle — flat enough that the ring
// clearly reads as edge-tilted, not so flat that the back/front split
// loses its visual punch.
export const RING_MINOR_OVER_MAJOR = 0.20;
// Per-ring tilt range in degrees. Each ring picks its tilt from the
// uniform [-RING_TILT_DEG_MAX, +RING_TILT_DEG_MAX] using a seed off
// the ring's id, so the same ring always tilts the same direction but
// different planets in the same system don't comb-align.
export const RING_TILT_DEG_MAX = 14;
// Visual scale applied to the ring's RADIAL WIDTH (outer − inner) at
// render time. The CSV's innerPlanetRadii / outerPlanetRadii stay in
// physical units (Saturn's rings really do extend ~2.3 R_S); this
// multiplier pulls the OUTER edge in toward the inner edge so the band
// reads as stubbier without bringing the inner edge inside the
// planet's silhouette. Inner edge stays at innerPlanetRadii × R_p
// (always outside the planet rim).
export const RING_WIDTH_VIZ_SCALE = 0.5;

// Segments per half-ellipse for the ice-ring triangle strips. 24 is
// the floor where the silhouette stops reading as a polygon at the
// largest realistic planet sizes; bumping past 32 is wasted geometry.
export const ICE_RING_SEGMENTS = 24;
// Debris-ring chunk density (chunks per px of ellipse perimeter) and
// clamp range. The perimeter approximation uses Ramanujan's first
// formula for the outer ellipse; close enough at our aspect ratios.
export const DEBRIS_RING_CHUNKS_PER_PX = 0.10;
export const DEBRIS_RING_CHUNKS_MIN = 18;
export const DEBRIS_RING_CHUNKS_MAX = 80;
// Debris ring chunk polygon half-extents (env-px). Same blob shape +
// rotation model as belt chunks; smaller scale since rings are visual
// texture around an existing object and shouldn't out-mass the host
// planet's disc.
export const DEBRIS_RING_CHUNK_SIZES = [2, 3, 3, 3];
// Brightness multiplier for debris ring chunks. Multiplies the
// BELT_CLASS_COLOR.debris value (~0x806848 → already dusty); pulling
// it down further per the brief ("darker thicker chunks") keeps debris
// distinct from the pale-cyan ice rings even at small sizes.
export const DEBRIS_RING_DIM = 0.75;

// --- Per-row-item depth ---
//
// Each row item (planet or belt) gets a slot of z range Z_STRIDE in
// world coordinates. Larger row index → larger world z → smaller
// fragment depth under our OrthographicCamera (near=-1, far=1,
// projection negates z so world_z=+1 maps to depth=0). The default
// depthFunc (LessEqual) lets smaller depth win, so the rightmost
// row item draws on top. With depthWrite enabled across the system-
// diagram materials, each planet's whole stack (back-moon → back-ring
// → disc → front-ring → front-moon) renders as one contiguous z-band
// that fully occludes — or is fully occluded by — neighboring
// planets' stacks. Z_STRIDE × max-row-items must fit inside the
// camera's [-1, 1] z range (Z_STRIDE 0.001 → 1000-item ceiling, far
// past any realistic system size).
export const Z_STRIDE = 0.001;
// Sub-offsets within one row item's z band. Listed deepest to most
// forward — back layers have NEGATIVE offsets (smaller world z =
// drawn under the planet disc); front layers have POSITIVE offsets
// (larger world z = drawn over the disc). Sub-offsets are an order
// of magnitude smaller than Z_STRIDE so adjacent row items' stacks
// never z-interleave.
export const Z_BACK_MOON  = -0.00040;
export const Z_BACK_RING  = -0.00030;
export const Z_BELT       =  0.00000;
export const Z_PLANET     =  0.00000;
export const Z_FRONT_RING = +0.00030;
export const Z_FRONT_MOON = +0.00040;

// --- Render order ---
//
// Render order is a secondary tiebreaker behind z (which the row-item
// banding above handles). These values keep tied-z scenarios settling
// the right way — e.g. an equal-z moon next to a ring chunk.
export const RENDER_ORDER_BACK_MOON  = 5;
export const RENDER_ORDER_BELT       = 6;
export const RENDER_ORDER_BACK_RING  = 7;
export const RENDER_ORDER_PLANET     = 10;
export const RENDER_ORDER_FRONT_RING = 13;
export const RENDER_ORDER_FRONT_MOON = 15;
