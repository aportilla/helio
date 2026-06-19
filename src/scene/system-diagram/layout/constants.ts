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

// Minimum distance from the buffer's LEFT edge to a star's center. A
// very small disc (BD, low-mass M dwarf) would otherwise center only a
// few px in from the edge — directly under the top-left back button
// (which spans edgePad + 2·iconBox + iconHitPad ≈ 44 px from the corner).
// Clamping the center rightward keeps even a tiny disc clear of the
// button. Only binds for small discs; a large disc's natural center
// (edgePad + radius) already sits well past it.
export const STAR_MIN_CENTER_FROM_LEFT = 65;

// Minimum distance the visible BOTTOM edge of a star disc sits below the
// buffer top — a hard floor on how high a disc may hang. The
// STAR_OFFSCREEN_FRAC rule offsets the center above the top by FRAC·r, so
// a disc's natural visible strip is r·(1−FRAC): proportional to radius,
// meaning a small disc clings to the very top with only a thin sliver
// showing. This floor decouples the smallest stars from that: it caps the
// upward offset so the bottom edge always clears the top by at least this
// much, pulling smaller discs DOWN (bringing the whole disc onto screen
// when it's shorter than the floor). Binds whenever r·(1−FRAC) < this —
// i.e. for radii under STAR_MIN_BOTTOM_DROP / (1 − STAR_OFFSCREEN_FRAC)
// (≈ d < 86 px), which covers BDs (d = 60), WDs, and the smaller M / K
// discs; larger stars keep the frac rule untouched and hang freely.
export const STAR_MIN_BOTTOM_DROP = 40;

// Outer radius of the star halo as a multiple of the disc radius. The
// halo is a dithered additive cloud that bleeds a saturation-stepped
// gradient (hot/warm/ember/dark, all in the star's own hue) into the
// surrounding scene (see makeStarHaloMaterial in materials/system-decor.ts).
// 3.0 pushes the dark fringe well into the dome area so the wash
// bleeds past the planet row before fading to black, giving the
// system a sense of being bathed in the star's light rather than
// parked in front of it. Planets paint over the halo where they overlap.
export const STAR_HALO_RADIUS_FACTOR = 3.0;

// System-view-only base-color tuning. Lifts a star's minor channels
// toward white by an amount proportional to how SATURATED the star's
// class color is (max(R,G,B) − min(R,G,B)). Highly saturated catalog
// colors — deep blue O/B/A or deep red M/BD — collide with the
// saturated dithered inner-edge ring + halo to read as "neon" against
// the body. Lifting the body softens it toward white in system view
// only; the fringe stays a touch darker, restoring natural balance.
// Galaxy view keeps the true class color (these constants only apply
// to the system diagram). Two knobs:
//   - SATURATION_LIFT_RATE: how strongly saturation drives lift.
//     ~1.4 puts Vega around lift 0.30 (subtle whitening); higher
//     values lift more.
//   - SATURATION_LIFT_MAX: hard cap on the lift so very saturated
//     stars (M, BD) don't fully wash out — without this, an M dwarf
//     with sat ≈ 0.58 would lift past 0.8 and lose its warm character.
export const SYSTEM_VIEW_SATURATION_LIFT_RATE = 1.4;
export const SYSTEM_VIEW_SATURATION_LIFT_MAX  = 0.35;

// --- Body dome ---

// Distance from the TOP of the screen to the dome's PEAK (where the
// middle planet sits). Fixed — the top of the arc stays at a constant
// gap below the stars regardless of viewport size; only the dome's
// edges move (see DOME_PEAK_*_PX below).
export const PLANET_PEAK_FROM_TOP = 100;

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

// Planet disc diameter (px) is two radius→size mappings blended into one
// curve (see planetDiscPx in row.ts). The catalog's radii are bimodal:
// rocky worlds spread smoothly from Mercury (0.38 R⊕) to ~2 R⊕, then gas
// giants pile up at 10–12 R⊕ because electron-degeneracy pressure flattens
// the mass→radius curve (a 0.5 and a 10 Jupiter-mass planet are both ~1 R_J).
// A single cube-root curve renders that pile-up as a near-flat plateau, so
// the two regimes get their own mapping:
//   • low-end: cube-root compression, Earth (1 R⊕) pinned to PLANET_DISC_BASE.
//   • high-end: a locally-linear slope across the dense giant band, so giants
//     that differ by a few R⊕ get a few px of separation instead of clamping.
// The blend hands off across [PLANET_DISC_BLEND_LO, PLANET_DISC_BLEND_HI],
// then a soft-min asymptotes the top to PLANET_DISC_ASYMPTOTE (a practical
// max approached, never reached — no hard clip / cliff) and a soft-max eases
// the smallest bodies onto PLANET_DISC_MIN. The whole curve is monotonic, so
// a bigger radius always renders at least as large.

// Smallest disc diameter (soft floor) and the practical max diameter the
// curve asymptotes toward. PLANET_DISC_MIN also seeds the belt height
// fallback when a star has no planets (see belts.ts).
export const PLANET_DISC_MIN = 36;
export const PLANET_DISC_ASYMPTOTE = 132;
// Low-end multiplier on cbrt(radiusEarth); equals Earth's pinned diameter
// since cbrt(1) = 1. Sets where rocky worlds land.
export const PLANET_DISC_BASE = 54;
// High-end mapping (giant band): px ≈ SLOPE·radiusEarth + OFFSET before the
// asymptote bends it over. The slope is what gives Jupiter-vs-super-Jupiter
// visible size separation.
export const PLANET_DISC_GIANT_SLOPE = 6.2;
export const PLANET_DISC_GIANT_OFFSET = 44;
// Radius band (R⊕) over which the low-end curve hands off to the high-end
// mapping via smoothstep.
export const PLANET_DISC_BLEND_LO = 4;
export const PLANET_DISC_BLEND_HI = 9;
// Knee widths (px) of the soft-min ceiling and soft-max floor — larger =
// gentler, earlier-starting bend; smaller = sharper corner.
export const PLANET_DISC_TOP_KNEE = 7;
export const PLANET_DISC_FLOOR_KNEE = 4;

// Moon discs: cube-root compression with soft-knee bounds (discPxFromRadius
// in row.ts), the small-body analogue of planetDiscPx. Moon radii are all
// sub-Earth, so there's no giant band to spread — but the radius range
// (~0.03–1.5 R⊕) still spans ~20× and must map across the px range without
// piling at either end. A flat cap collapsed roughly a third of all moons
// onto one value (every radius past the cap threshold rendered identical);
// BASE is anchored so the largest moons (the procgen mass ceiling near
// 1.5 R⊕) approach the 42 px asymptote and the smooth right-skewed radius
// distribution spreads naturally below it — the median moon (~0.21 R⊕) lands
// ~21 px, the smallest (~0.03 R⊕) ease onto ~12 px. The soft asymptote (no
// hard clip) is what avoids the pile-up: radii past the knee compress gently
// instead of stacking. The 42 px ceiling still exceeds the planet floor on
// purpose — moons read against their parent, and big moons orbit big planets
// (Ganymede / Titan around gas giants), so a top-end moon always sits next
// to a 100+ px parent. TOP_KNEE sets how wide the upper bend; FLOOR_KNEE
// eases the smallest onto MOON_DISC_MIN.
export const MOON_DISC_MIN = 10;
export const MOON_DISC_MAX = 42;
export const MOON_DISC_TOP_KNEE = 3.5;
// Floor knee wide enough that the soft-max actually engages: the smallest
// moons' raw cbrt value already sits just above MIN, so a narrow knee would
// leave them untouched — 2.5 lifts the smallest from ~11 px onto ~12 px.
export const MOON_DISC_FLOOR_KNEE = 2.5;
// Multiplier on cbrt(radiusEarth) before the knees. 36 puts the ~1.5 R⊕
// ceiling moons near the 42 px asymptote (see MOON_DISC_* above).
export const MOON_DISC_BASE = 36;

// Moon-center distance from parent center, expressed as an offset
// relative to parent's rim. 0 = moon centered exactly on the parent's
// rim (half the moon disc inside the parent, half outside). Positive
// pushes moons outward; negative pulls them inward.
export const MOON_EDGE_BIAS = 0;

// Disc-diameter floor (env-px) below which a body forces flat fill and
// skips the whole procedural suite (surface texture + clouds + haze +
// biome stipple + limb scatter). Set just under the moon disc floor
// (MOON_DISC_MIN; smallest moon ~12 px) so every rendered body runs the
// full procedural path — small moons read as chunky pixel surfaces, not
// flat discs. Kept as a safety floor only: nothing currently renders
// below it (planets floor at PLANET_DISC_MIN = 36), but a future tinier
// body would flat-fill rather than dissolve into per-pixel noise.
export const PROCEDURAL_TEXTURE_MIN_PX = 10;

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
// the ships area. Clamped by BELT_HEIGHT_MAX_PX so a row carrying a
// large gas giant doesn't stretch the column to the full viewport.
export const BELT_HEIGHT_FACTOR = 3.0;
// Absolute ceiling (env-px) on a belt column's height. Caps the
// proportional BELT_HEIGHT_FACTOR scaling so only the biggest-planet
// rows (gas giants near PLANET_DISC_MAX) get trimmed; typical rows
// stay fully proportional.
export const BELT_HEIGHT_MAX_PX = 260;
// Lean of a belt column off vertical, applied as a rigid rotation of the
// sampled chunk-center scatter (the camera is y-up, so a clockwise turn
// leans the band's top toward +x). The band keeps its thin-stretched
// shape — it just runs on a diagonal rather than straight up the slot.
export const BELT_TILT_RAD = 40 * Math.PI / 180;
// Chunk count range per belt. Smallest masses bottom out at MIN; the
// largest belts approach MAX. Log-based so a 100× mass range only
// doubles chunk count. This is the mass-derived count *before* the
// small-body inflation below — belts with smaller parent bodies divide
// the rendered chunk size down (see BELT_CHUNK_SCALE_*) and bump the
// count up to keep painted area (≈ belt mass) roughly fixed, so a dust
// cascade reads as a dense fine swarm rather than a sparse one.
export const BELT_CHUNKS_MIN = 20;
export const BELT_CHUNKS_MAX = 50;
// Absolute ceiling on chunk count after small-body inflation. A belt
// with the smallest chunks (sizeScale at BELT_CHUNK_SCALE_MIN) would
// otherwise inflate its mass-count by 1/sizeScale²; this caps the
// vertex budget so a tiny-bodied belt can't blow up the pool.
export const BELT_CHUNKS_HARD_MAX = 150;
// Per-chunk polygon half-extent in env-px. A chunk's silhouette is one
// of the blob.ts shape-library polygons (POTATO_SHAPES / CRYSTAL_SHAPES)
// inscribed in a unit circle, scaled by this size and rotated by a
// per-chunk angle, so the visible footprint is roughly (2*size) ×
// (2*size) with the polygon filling ~60% of the bbox. This is the
// *base* palette — each belt scales the whole array by a multiplier
// derived from its largestBodyKm (see below), so the relative
// within-belt size spread is preserved while the absolute scale tracks
// the parent-body inventory.
export const BELT_CHUNK_SIZES = [2, 3, 4, 5, 6];
// largestBodyKm → per-belt multiplier on BELT_CHUNK_SIZES. A belt's
// largest parent body spans ~1 km (trace dust cascades) to ~2400 km
// (Pluto/Eris-class KBO inventories); that ~3-decade log range maps
// onto a size multiplier. BELT_CHUNK_SIZES is already tuned for the
// large end, so SCALE_MAX is 1.0 — a Ceres/Pluto-class shepherded belt
// renders at the base palette and everything smaller scales *down*
// toward SCALE_MIN, so a floor dust band reads as fine gravel rather
// than boulders. The rendered chunk scale tracks the same metadata the
// info card reports.
export const BELT_CHUNK_KM_MIN = 1;
export const BELT_CHUNK_KM_MAX = 2500;
export const BELT_CHUNK_SCALE_MIN = 0.5;
export const BELT_CHUNK_SCALE_MAX = 1.0;

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

// Segments per half-ellipse for the ring triangle strips. 24 is the
// floor where the silhouette stops reading as a polygon at the largest
// realistic planet sizes; bumping past 32 is wasted geometry.
export const RING_SEGMENTS = 24;

// Baseline opacity of the ring's translucent floor — the level the
// concentric ringlines modulate their own opacity around (see
// makeRingMaterial). The icy↔dusty scalar (bodyIcyness) lerps between
// them: an icy Saturn-class ring rides a near-solid floor, a dusty
// Uranus/Neptune-class ring rides a faint one so the background reads
// through. Dense lines paint more opaque than the floor, sparse lines
// fainter, so the disc reads as a stack of distinct lines.
export const RING_FLOOR_ALPHA_ICY   = 0.72;
export const RING_FLOOR_ALPHA_DUSTY = 0.40;

// Saturation multiplier applied to the ring's rocky↔icy palette color
// (beltRingColor) before it reaches the material. Pulls the disc toward a
// muted, dusty-pale read rather than a saturated tint — the resource hue
// still tilts the gray, but quietly. Belts keep the full-saturation color;
// only rings damp it (the wide thin annulus reads better desaturated).
export const RING_COLOR_SATURATION = 0.45;

// Fallback ring extent (in host-planet radii) when the body carries no
// innerPlanetRadii / outerPlanetRadii — a generic Saturn-ish band so a
// ring still renders rather than collapsing to zero width.
export const RING_INNER_FRAC_FALLBACK = 1.1;
export const RING_OUTER_FRAC_FALLBACK = 2.0;

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

// Star halos draw FIRST — additive blending into the cleared
// framebuffer. Every later pass (belts, planets, rings, moons) paints
// over them, so the warm wash ends up behind every body in the scene.
// Star discs themselves keep the default renderOrder 0; the halo
// discards inside the disc radius so the disc still renders on top.
export const RENDER_ORDER_STAR_HALO  = -1;
export const RENDER_ORDER_BACK_MOON  = 5;
export const RENDER_ORDER_BELT       = 6;
export const RENDER_ORDER_PLANET     = 10;
// Back rings run AFTER planet discs so a translucent back-half can
// blend over a left-neighbor's disc (otherwise it would paint against
// the cleared framebuffer and depth-reject the disc that's "behind"
// it). Within R's own stack, the back ring is still hidden by R's
// disc via depth test (back ring at z_R - 0.0003 fails LessEqual
// against R's disc at z_R) — render-order doesn't need to enforce
// it. Belts (opaque) don't have the same blend issue, so they stay
// at renderOrder 6.
export const RENDER_ORDER_BACK_RING  = 12;
export const RENDER_ORDER_FRONT_RING = 13;
export const RENDER_ORDER_FRONT_MOON = 15;
// Planet atmospheric halo runs last so it blends over the left
// neighbor's front-ring / front-moon (which the planet pass at
// renderOrder 10 hasn't drawn yet). Within the pass, depth test
// keeps R's halo from painting over R's own front ring/moon
// (higher z) and lets it paint over L's full stack (lower z).
export const RENDER_ORDER_PLANET_HALO = 20;
// Cargo-ship dots are a flat overlay that flies OVER every body, so they
// render after the planet halo and sit at a fixed z nearer than any row
// band (see Z_SHIP) — they belong to no row item.
export const RENDER_ORDER_SHIP = 30;
// Thrust-burn flares render just UNDER the dots (lower renderOrder draws first),
// so a ship's dot paints over the tip of its own burn line.
export const RENDER_ORDER_SHIP_THRUST = 29;

// --- Cargo ships (economy traffic) ---
//
// Animated dots representing the cluster's cargo lanes while a system is open. A
// lane's volume is rendered as a continuous emission RATE; dots ride a quadratic
// Bézier (body→body lanes arc) from a scattered source point to a scattered
// destination point — accelerating out of / braking into a body end — and despawn at B.
// All values are the "edit a number, reload, eyeball" tuning surface.

// Fixed world-z for the whole ship pool. The diagram's ortho camera maps world
// z linearly to NDC over [-1, 1] (near -1 / far 1), so any small z renders fine.
// Z_SHIP sits within the body-band span (rowIdx·Z_STRIDE + Z_FRONT_MOON) but not
// strictly ahead of the deepest row. Ships don't rely on z for layering: the
// material runs depthTest:false + a high renderOrder, so they always paint over
// every body regardless of the exact z.
export const Z_SHIP = 0.005;

// Pre-allocated dot pool size. A hard ceiling on simultaneously-visible
// dots; a turn that would emit more drops the surplus spawns (saturation
// cap) rather than growing the buffer.
export const SHIP_POOL_CAP = 512;

// One neutral cargo color for v1 (pale cyan, in the cyan-on-near-black
// palette). Per-resource tinting is a documented follow-up.
export const SHIP_COLOR = 0x8fd3ff;

// Dot size in env-px. 2 px reads as visible cargo traffic without going chunky —
// a single pixel proved too faint to register against the bodies. An even size
// centers on a pixel boundary via snappedDotsMat's parity snap, so the square
// stays crisp.
export const SHIP_SIZE_PX = 2;

// Cruise pace, expressed as the wall-clock SECONDS for a dot to traverse the full
// content width; a chord shorter than the screen scales down in proportion, so
// every dot's journey takes the same TIME on any window size (px/sec auto-scales
// with the viewport instead of being fixed). The constant-acceleration ramps
// (SHIP_ACCEL_SEC) bring a dot up to and down from this cruise. Deliberately slow
// so dots LINGER in flight
// — more stay on screen at once, so even a small flow reads as a continuous
// trickle rather than a lone blip. Raise to slow traffic down, lower to speed up.
export const SHIP_CROSS_SCREEN_SEC = 65;

// Per-ship speed variance. Each dot's cruise pace is multiplied by a random factor
// in [1 − V/2, 1 + V/2], fixed for its whole journey, so ships spread across a
// V-wide band (here 30%) instead of moving in lockstep — a livelier stream. The
// band is centered on 1, so the mean pace stays SHIP_CROSS_SCREEN_SEC.
export const SHIP_SPEED_VARIANCE = 0.3;

// Exhaust burn: a short, bright-yellow flame trailing off the ship opposite its
// thrust, lit only while it's accelerating or braking (the SHIP_ACCEL_SEC ramps)
// and off through cruise — streaming behind a dot as it accelerates out of the
// source and out the front as it brakes into the destination. One tip sits on the
// dot; SHIP_THRUST_LEN_PX is how far the other reaches (env-px). The line is 1px.
export const SHIP_THRUST_COLOR = 0xffff00;
export const SHIP_THRUST_LEN_PX = 3;

// Emission rate mapping: dots/sec per milli-unit shipped on a lane this turn,
// clamped so a small flow still reads as a steady trickle and a glut can't swamp
// the dome or the pool. Calibrated for early-game amounts (a colony's food
// surplus split across consumers is only a few hundred milli per lane), so most
// lanes ride near the floor until the economy scales up.
export const SHIP_RATE_PER_MILLI = 0.002;
export const SHIP_RATE_MIN_PER_LANE = 0.27;
export const SHIP_RATE_MAX_PER_LANE = 3.3;

// Pixels past a screen edge a dot travels before despawning, so it fully
// clears the edge rather than blinking out at it. Used for the off-screen
// end of outgoing/incoming (the top) and through-traffic (the sides).
export const SHIP_OFFSCREEN_MARGIN = 24;

// Height of the horizontal through-traffic band, measured down from the top
// of the content rect — above the dome's planet peak (PLANET_PEAK_FROM_TOP)
// so transit cargo reads as crossing "above the planets", distinct from the
// vertical in/out columns.
export const SHIP_TRANSIT_FROM_TOP = 56;

// Per-frame dt clamp (ms) — mirrors the galaxy scene's MAX_TICK_DT_MS so a
// backgrounded tab resuming doesn't dump a burst of spawns or teleport
// in-flight dots.
export const SHIP_MAX_TICK_DT_MS = 100;

// Body-to-body (internal) lanes bow into an arc rather than a straight chord, so
// crossing traffic streams read as distinct curved corridors. The control point
// is offset perpendicular to the chord by a fraction of the chord length drawn
// from [MIN, MAX]; the rendered apex deflection is HALF that (a quadratic Bézier
// peaks at half its control offset). Sign is seeded per ordered body-pair so
// opposite-direction lanes bow apart, and the value is procedurally stable across
// loads (see ShipsLayer.bowFor).
export const SHIP_ARC_BOW_MIN = 0.18;
export const SHIP_ARC_BOW_MAX = 0.42;
// The bodies already sit on a shallow upward sweep, so a downward-bowing arc drops
// into the empty lower field and reads as a much deeper dip than an equal upward
// bow. Damp the DOWNWARD half of the range by this factor (applied at render, where
// the chord's true orientation is known) so down-arcs stay shallow while up-arcs are
// untouched.
export const SHIP_ARC_BOW_DOWN_SCALE = 0.45;

// Acceleration profiling. A dot ramps from rest to cruise under CONSTANT
// acceleration over a STANDARD WALL-CLOCK duration (SHIP_ACCEL_SEC) — NOT a fixed
// fraction of the path — so a short hop accelerates just as gently as a long haul
// instead of snapping to full speed. The accel covers a fixed distance, so a trip
// too short to fit accel + decel never reaches cruise: it peaks at its midpoint (a
// triangular velocity profile) and starts braking immediately. SHIP_EASE_FLOOR is
// the minimum crawl speed (fraction of cruise) so the rest-to-rest ends inch into
// the despawn rather than dividing-by-zero into a stall. Raise SHIP_ACCEL_SEC for
// longer, gentler ramps; lower it for snappier starts.
export const SHIP_ACCEL_SEC = 8;
export const SHIP_EASE_FLOOR = 0.15;
