# src/data — runtime catalog API + types

This is the runtime side of the star catalog — it imports the precomputed `catalog.generated.json` and exposes typed `STARS` / `STAR_CLUSTERS` / `BODIES`, the `Star` / `Body` / `StarCluster` types, lookup helpers, the cluster k-d tree, and the bundled bitmap fonts. The BUILD pipeline that produces the JSON (catalog build, body procgen, multi-star layout) lives in [the scripts doc](../../scripts/README.md) — start there for any data-authoring or procgen task. Everything documented here is the read-only runtime surface other modules consume.

## Files

- `nearest-stars.csv` — 0–20 ly bracket; Wikipedia-seeded, hand-tunable
- `stars-20-25ly.csv` — 20–25 ly bracket
- `stars-25-30ly.csv` — 25–30 ly bracket
- `stars-30-35ly.csv` — 30–35 ly bracket
- `stars-35-40ly.csv` — 35–40 ly bracket; catalog-seeded (no Wikipedia source)
- `stars-40-45ly.csv` — 40–45 ly bracket; catalog-seeded
- `stars-45-50ly.csv` — 45–50 ly bracket; catalog-seeded
- `bodies.csv` — Planets + moons + belts + rings; host_id joins to a Star.id (planets/belts) or a Body.id (moons/rings)
- `body_layers.csv` — body_id → atmospheric layer composition (gas, coverage, wind, altitude)
- `catalog.generated.json` — Build artifact (gitignored). Precomputed STARS + STAR_CLUSTERS + BODIES.
- `stars.ts` — Runtime catalog API — imports the JSON, exposes typed STARS/STAR_CLUSTERS/BODIES, k-d tree, lookups
- `kdtree.ts` — Static 3D k-d tree backing nearest-cluster queries
- `BDF/<Family>/<n>.bdf` — Bundled bitmap fonts (Monaco, EspySans, EspySansBold)
- `bdf-font.ts` — BDF parser + per-font canvas atlas renderer
- `font-provider.ts` — Typed FONTS catalog; lazy registration + DEV drift check
- `pixel-font.ts` — makeLabelTexture / drawPixelText composition helpers

## Runtime API

`stars.ts` re-exports the precomputed catalog as immutable arrays and the types and helpers other modules read off it:

- `STARS: readonly Star[]`, `STAR_CLUSTERS: readonly StarCluster[]`, `BODIES: readonly Body[]` — the three catalog arrays, asserted to the `Star` / `StarCluster` / `Body` interfaces (a DEV-only pass walks the freshly-cast arrays and warns on structural drift the cast let through).
- The type definitions consumers depend on: `Star`, `Body`, `StarCluster`, plus the field vocabularies (`SpectralClass`, `BodyKind`, `BodySource`, `BiosphereArchetype` / `BiosphereComplexity` / `BiosphereImpactLevel`, `SurfaceLiquidSpecies`, `SurfaceFrostSpecies`, `CloudLayer`, `AtmGas`, `ResourceKey`).
- `clusterIndexFor(starIdx)` — the cluster index a given star belongs to.
- `clusterDisplayName(clusterIdx)` — the cluster's primary name with a ` +N` suffix when it carries N additional members.
- `nearestClusterIdxTo(x, y, z)` — nearest cluster by COM, backed by the k-d tree.
- `indexOfBodyId(id)` — stable `Body.id` → `BODIES` index (or `-1`), used to resolve persisted game-state facilities.
- `systemIdForCluster(clusterIdx)` / `systemIdForBody(body)` / `systemIdForBodyId(id)` / `systemExists(id)` — a body or cluster's **stable system handle** (the cluster primary's star slug); `systemExists` gates skip-on-missing pruning of persisted game-state ships, which are system-keyed rather than body-keyed.
- `CLASS_COLOR` — approximate blackbody color per spectral class, consumed by the stars shader.
- `WAYPOINT_STAR_IDS` — the curated set of waypoint-star slugs the labels module promotes.

## Bitmap fonts

The HUD draws from a catalog of Mac-classic bitmap fonts shipped as `.bdf` files under `src/data/BDF/<Family>/<size>.bdf`. Vite's `import.meta.glob('./BDF/**/*.bdf', { query: '?raw', eager: true })` bundles every file as a string at build time; `font-provider.ts` indexes them by `(family, size)` and parses lazily on first `getFont(spec)` request. A typed `FONTS` constant gives callers autocomplete:

```ts
import { FONTS } from './data/font-provider';
FONTS.Monaco[11]      // ok
FONTS.Monaco[999]     // ts error — no such size
FONTS.NotAFamily      // ts error — no such family
```

In DEV builds, a drift check warns if `FONTS` and the on-disk directory disagree — a typo in a typed entry, or a `.bdf` added without one (so callers can't autocomplete to it).

`initFonts()` (called once from `main.ts` before any label texture is built) eagerly parses **Monaco 11** so the first frame doesn't pay parse cost on the body font, and injects the custom `►` (U+25BA, used in info-card name lines) onto Monaco via `BdfFont.addGlyph()`. Coverage beyond that is whatever the `.bdf` source carries — printable ASCII for every font, plus the typical Mac symbol set (`°`, `·`, `—`, etc.) on most. MacRoman codepoints 128–255 are remapped to Unicode by glyph name (`degree` → U+00B0, `bullet` → U+00B7, `emdash` → U+2014); glyphs named `uniXXXX` carry their codepoint in the name.

`bdf-font.ts` builds one canvas atlas per font, with white-on-transparent pixels: white callers take a fast direct-blit path; other colors route through a per-call temp canvas with `source-in` tinting. Memory stays at one atlas per font regardless of how many colors are used.

The HUD's font selections live in `src/ui/theme.ts` — EspySans 20 for the title, EspySans 15 for card/panel headers, Monaco 11 for body text. Tweak the tokens there to swap fonts globally.

`makeLabelTexture(...)` (in `pixel-font.ts`) is overloaded three ways:
- `(text, color, opts?)` — single line, single color
- `(segments, opts?)` — single line with per-segment colors (`TextSegment[]`)
- `(lines, opts?)` — multi-line with per-segment colors per line (`TextSegment[][]`)

Options:
- `font: FONTS.Family[size]` — pick the font; defaults to Monaco 11

Also exports `drawPixelText(g2d, text, x, y, color, font?)` so the HUD can compose text into its own canvases alongside borders/fills without going through `makeLabelTexture`.

To add a font, drop the `.bdf` at `src/data/BDF/<Family>/<size>.bdf` and add a typed entry to `FONTS` in `font-provider.ts`. To add a glyph that isn't in the source — like a custom UI symbol — parse the font and call `addGlyph(codepoint, glyph)` on it; the atlas rebuilds lazily on the next draw. The `►` injection in `initFonts()` is the canonical example.

## Star color and size

- **`CLASS_COLOR`** in `src/data/stars.ts` — approximate blackbody color per spectral class (Mitchell Charity table). O/B/A trend blue, F/G white, K/M orange-red, WD pale blue, BD deep red. Color stays class-driven because it's a temperature signal, not a size one.
- **Per-star `pxSize`**, baked at build time by `radiusToPxSize(s.radiusSolar)` in `build-catalog.mjs`. The Wikipedia source table doesn't carry a radius column, so each entry's `radiusSolar` is derived at the same point from class + mass: Chandrasekhar `M^(−1/3)` for white dwarfs (anchored at ~0.012 R☉ for a 0.6 M☉ WD), a Jupiter-radius constant (~0.10 R☉) for brown dwarfs, and a rough main-sequence `M^0.8` anchored at the Sun (1 M☉ = 1 R☉) elsewhere. Loses the subgiant offset for entries like Procyon A; accepted regression for source-of-truth simplicity. The mapping is `R^(1/3)` linear, anchored so Sirius B-class WDs (~0.012 R☉) land near pxSize 3 and the largest A-class dwarfs (~2 R☉) near 18. The shader takes `pxSize`, scales by the `uPxScale` divisor (the global size knob — bump that divisor to shrink all stars uniformly), applies the depth-attenuation factor, floors at 2 px, and rounds to integer.

Real radii in the catalog span a couple-hundred-fold range (Sirius B → Procyon A), so a linear mapping would make WDs invisible and A-class dwarfs dominate. Cube-root compression collapses that wide radius range into a narrow pixel range, so white dwarfs stay visible at the small end while A-dwarfs don't run away at the large end — keeping the class spacing legible without clipping. It also preserves within-class variation: Wolf 359 (0.144 R☉) and Lalande 21185 (0.392 R☉) render as visibly different M dwarfs.

## Star clusters

Stars within `CLUSTER_THRESHOLD_LY` of each other (`buildClusters` in `scripts/build-catalog.mjs`) are grouped via union-find at build time. Captures both ringed-out coincident binaries (e.g. Sirius A/B share Wikipedia's RA/Dec, post-processed onto a small ring) and hierarchical systems where Wikipedia gives one component a different RA/Dec (Alpha Centauri's Proxima ends up ~0.19 ly from the AB pair after the equatorial-to-galactic conversion, well inside the threshold). Each cluster has a **primary** (the heaviest member by `mass`, with `pxSize` as a tie-breaker) and an ordered `members` list with the primary first.

`Labels` (in `src/scene/labels.ts`) renders one visible label per cluster — anchored at the primary's position, suffixed with ` +N` (in dim cyan) when the cluster has additional members. Two textures per cluster are eagerly built at construction: a **plain** variant (cyan, warm-white for Sol) and a **yellow** variant (reticle yellow `#ffe98a`, matching the cluster brackets and the info-card star name). The yellow variant is shown when the cluster is selected OR is the active candidate (hover or focus-proximity — see "Cluster brackets" in [the scene doc](../scene/README.md)). Same dimensions, same anchor offset, so the swap is positionally invisible. Anchored at the primary so the emphasis doesn't twitch as you move between near-coincident dots.

Lookup helpers exported alongside the catalog: `STAR_CLUSTERS: readonly StarCluster[]` and `clusterIndexFor(starIdx) => number`.

## Naming: display vs. IAU canonical

Each catalog row carries two name fields. `name` is the **display name** — colloquial, what players see in labels and the info card title: `Toliman`, `Fomalhaut`, `Proxima Centauri`. `iau_name` (CSV column) is the **IAU canonical designation** — `Alpha Centauri B`, `Fomalhaut A`, `Alpha Centauri C`. The two coalesce in the renderer when they'd duplicate, so the column stays empty for the rows where the display name already matches IAU (`Sirius A`, `Capella Aa`, `61 Cygni A`). Only the handful of hand-curated colloquial rows whose display name diverges from the IAU designation (e.g. `Toliman`) populate `iau_name`.

The info card surfaces both layers as a hierarchy: the bright yellow title is the display name, and a dim-blue Monaco line beneath it carries the IAU canonical when it differs. So a Toliman selection reads `TOLIMAN / Alpha Centauri B` rather than collapsing the two identities into one ambiguous string. Multi-member clusters move the IAU line under each member sub-header instead of the title, since each member has its own potential divergence and a single title-level line couldn't represent all three Alpha Cen components.

Hierarchy parsing for the multi-star layout (see [the scripts doc](../../scripts/README.md)) keys off `id` rather than either name field — the slug always carries the IAU component letter as the trailing suffix (`alpha-centauri-b`, `capella-aa`) regardless of how colloquial the display name gets. Player-renaming, when it lands, will override `name` from save state without touching `id` or `iau_name`, so the IAU layer stays as a stable anchor.

The catalog also stores the **raw spectral class string** (`G3III:`, `M4.0Ve`, `DA1.9`) on each star, alongside the normalized single-letter `cls` used internally for color and font lookups. The info card displays the raw form so luminosity class and variability flags surface for players; the single-letter normalization stays out of the UI.
