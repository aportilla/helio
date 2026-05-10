# scripts/ — star catalog tooling

Scripts for seeding, repairing, and extending the per-bracket CSVs in `src/data/`. All are throwaway-safe ESM scripts run with `node scripts/<name>.mjs`. None are wired into the build — they exist for catalog maintenance.

## Source-of-truth policy

The CSVs in `src/data/` are **canonical**. Hand-edits are welcome and survive script runs.

- The Wikipedia scraper refuses to overwrite an existing CSV without `--force=1`.
- The stellarcatalog filler **only fills empty cells** — it never overwrites a populated one.
- When upstream Wikipedia data is wrong or incomplete, fix it in the CSV by hand. The CSV wins.

If a CSV gets corrupted (e.g. by a scraper bug), the recovery path is to clear the affected fields, then re-run the filler — stellarcatalog acts as the canonical remote source for re-establishing broken records.

## Scripts at a glance

| Script | Purpose |
|---|---|
| `scrape-wiki-stars.mjs` | Initial-seed a CSV from a Wikipedia "List of star systems within X-Y light-years" table. |
| `find-missing-stars.mjs` | Compare a CSV against the local stellarcatalog listing; report (or `--add`) stars present in the catalog but absent from the CSV. |
| `fill-from-stellarcatalog.mjs` | For rows missing some field, fetch the star's stellarcatalog detail page and fill empty cells. Cached on disk. |
| `sync-with-catalog.mjs` | Sweep all CSVs against the catalog: assign each row a stable `id` (catalog slug) and rewrite `name` to the catalog's primary, with component-letter preservation and a hardcoded skip-list for known regressions. Default dry-run; `--apply` to write. |
| `expand-systems-from-catalog.mjs` | For every row whose `id` is a catalog primary slug ending in `-a`, fetch the primary's detail page, parse `<h2 class='title'>` blocks for sibling components, and (a) update existing sibling rows' ids to the canonical convention or (b) add missing sibling rows with the catalog-derived spectral class + mass + the primary's RA/Dec. Default dry-run; `--apply` to write. **Largely superseded by `import-system-from-catalog.mjs`** for new system additions; kept for incremental id-suffix migrations on existing data. |
| `import-system-from-catalog.mjs` | Take a primary catalog slug and rewrite all CSV rows for that system from the catalog's detail page. The catalog is the source of truth for everything: per-component display names, spectral_class, mass, V magnitudes from each `<h2 class='title'>` section; position fields (distance/RA/Dec/parallax) from the primary's section, inherited by all siblings (so the renderer's `expandCoincidentSets` rings them as one cluster). Hand-curated names (Toliman, Guniibuu) and existing field values are preserved when the catalog is silent or wrong. Default dry-run; `--apply` to write. |
| `audit-unresolved.mjs` | Read-only report. Categorize every row whose id isn't a literal catalog slug as OVERLAP / NEAR / DISTINCT based on 3D distance to the nearest catalog-matched row. Useful for spotting truly orphaned rows after sync + expand. |
| `lookup-star.mjs` | Resolve a star name (or distance range) to a stellarcatalog URL. Useful for ad-hoc poking. |
| `lib/catalog-index.mjs` | Shared helpers: catalog HTML parsing, name normalization + variant generation, per-component section parsing for detail pages, CSV (de)serialization. Imported by the other scripts. |

The local stellarcatalog listing defaults to `~/Documents/catalog.html` (override with `--catalog=PATH` on any script that uses it). The cache for fetched detail pages lives at `.cache/stellarcatalog/` (gitignored).

## Common workflows

### Bootstrap a new distance bracket from the catalog

Best when the bracket is far enough out that Wikipedia's table is sparser than stellarcatalog's coverage (true from ~30 ly outward).

```bash
# 1. Empty CSV with the canonical header
echo "id,name,distance_ly,constellation,ra_deg,dec_deg,spectral_class,mass_msun,app_mag,abs_mag,parallax_mas" \
  > src/data/stars-40-45ly.csv

# 2. Append every catalog star in [40, 45] ly (range inferred from filename;
#    populates the id column from the catalog slug)
node scripts/find-missing-stars.mjs --csv=src/data/stars-40-45ly.csv --add

# 3. Fetch each detail page and fill RA/Dec, mass, magnitudes, etc.
node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-40-45ly.csv --needs=any

# 4. Pull in sibling rows for any multi-star primaries the bootstrap added
node scripts/expand-systems-from-catalog.mjs --apply

# 5. Wire into src/data/stars.ts:
#    - add `import fortyFortyFiveCsv from './stars-40-45ly.csv?raw';`
#    - add `{ text: fortyFortyFiveCsv, label: 'stars-40-45ly.csv' }` to the sources array

# 6. Update README's project layout to mention the new file
```

### Bootstrap a new distance bracket from Wikipedia (closer brackets)

The 0-30 ly Wikipedia tables are well-curated and worth using as the seed. Two known table layouts are baked into the scraper as `--schema` profiles.

```bash
# 1. Scrape the upstream Wikipedia table
node scripts/scrape-wiki-stars.mjs \
  --page='List_of_star_systems_within_15–20_light-years' \
  --schema=20-25 \
  --out=src/data/stars-15-20ly.csv

# 2. Fill anything Wikipedia left blank
node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-15-20ly.csv --needs=any

# 3. Sweep up catalog stars Wikipedia missed entirely
node scripts/find-missing-stars.mjs --csv=src/data/stars-15-20ly.csv --add
node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-15-20ly.csv --needs=any

# 4. Pull in sibling rows for any multi-star primaries
node scripts/expand-systems-from-catalog.mjs --apply

# 5. Wire into stars.ts as above
```

The two known schemas are `--schema=nearest` (11-col, used by "List of nearest stars") and `--schema=20-25` (9-col, used by every "List of star systems within X-Y light-years" page). If a future Wikipedia page uses yet another column layout, add a profile to the `SCHEMAS` dict in `scrape-wiki-stars.mjs`.

### Find what's missing

```bash
# How many catalog stars in a CSV's distance bracket aren't in any of our CSVs?
node scripts/find-missing-stars.mjs --csv=src/data/stars-25-30ly.csv

# Override the auto-detected range
node scripts/find-missing-stars.mjs --csv=src/data/stars-25-30ly.csv --range=20,30
```

The matcher checks against names from **all** CSVs in `src/data/` (not just the targeted one), because catalog distances are rounded to 1 decimal and a star at 25.045 ly shows up as "25" — without cross-CSV matching every boundary star false-positives.

### Fill missing fields on rows we already have

```bash
# Default: rows missing RA/Dec
node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-30-35ly.csv

# Other targeting
node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-30-35ly.csv --needs=mass
node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-30-35ly.csv --needs=any

# Faster throttle (default is 500ms between fresh fetches; cache hits are free)
node scripts/fill-from-stellarcatalog.mjs --csv=PATH --throttle=200

# See what would change without writing
node scripts/fill-from-stellarcatalog.mjs --csv=PATH --needs=any --dry-run
```

`--needs` accepts `radec`, `mass`, `class`, `app_mag`, `parallax`, `any`. In every mode the script fills *all* empty fillable cells once a page is fetched — `--needs=mass` will incidentally fill any missing RA/Dec on the same row. The flag controls only which rows trigger a lookup.

### Sync names + ids with the catalog

After any bracket changes (new bootstrap, hand-edits, reseeded data), run sync to canonicalize ids and align display names with the catalog's primary names.

```bash
# Dry-run across all CSVs in src/data/
node scripts/sync-with-catalog.mjs

# Apply
node scripts/sync-with-catalog.mjs --apply
```

The script:
- Adds the `id` column if missing (schema migration).
- Sets each row's id to the catalog slug (e.g. `fomalhaut-a`, `gliese-1`), with sibling components getting `<primary-stem>-<letter>` (e.g. `sirius-b`).
- Rewrites `name` to the catalog primary, preserving component letter when ours has one and the catalog primary doesn't.
- Honors a hardcoded `SKIP_RENAMES` set for known regressions (Barnard's Star, Luyten's Star, Keid, Achird, Alsafi, Guniibuu, Rigil Kentaurus, etc.) — these still get ids, just keep their display names. Add to that set in the script when a new regression is found.

### Expand multi-star systems

For each row whose `id` is a catalog primary slug, fetches the primary's detail page and uses the `<h2 class='title'>` sections as the source of truth for what siblings exist. Either updates an existing CSV row's id to the canonical convention, or appends a new sibling row populated with the catalog-derived spectral class + mass + the primary's RA/Dec.

```bash
node scripts/expand-systems-from-catalog.mjs            # dry-run
node scripts/expand-systems-from-catalog.mjs --apply
```

Run after sync, and any time you add new primaries to a CSV. The script handles three matching paths in priority order: (1) canonical id match, (2) name-variant overlap with letter-suffix equality, (3) RA/Dec proximity to the primary with letter-suffix equality. A small `KNOWN_COMPONENT_ALIASES` map covers IAU proper names like Toliman that don't carry a component letter at all.

### Audit unresolved rows

Read-only sanity check after sync + expand:

```bash
node scripts/audit-unresolved.mjs
```

Buckets every row whose id isn't a literal catalog slug into OVERLAP (within 0.05 ly of a catalog row — usually a constructed sibling id), NEAR (within 0.5 ly), or DISTINCT (further). DISTINCT is the watchlist: those rows have no nearby catalog primary at all, meaning the catalog genuinely lacks the entry.

### Repair a corrupted CSV

When a scraper bug or upstream edit produces wrong data:

```bash
# 1. Fix the underlying scraper bug if it was one
# 2. Re-scrape (the scraper refuses to overwrite without --force)
node scripts/scrape-wiki-stars.mjs --page=... --schema=... --out=src/data/stars-NN-MMly.csv --force=1

# 3. Re-run the catalog filler to repopulate (cache makes this instant)
node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-NN-MMly.csv --needs=any

# 4. Optionally re-add stars Wikipedia missed
node scripts/find-missing-stars.mjs --csv=src/data/stars-NN-MMly.csv --add
node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-NN-MMly.csv --needs=any
```

For partial repair (a few corrupt rows in an otherwise good CSV), hand-clear the bad cells and run `fill-from-stellarcatalog.mjs --needs=any` — only the empty cells get refilled.

When the corruption is upstream (the catalog has two slugs for the same physical star and one of them has wrong RA/Dec/distance — see `wise-2220-3628` vs `wise-j22205531-3628174` for the canonical example), add an entry to `STALE_SLUG_REDIRECTS` in `lib/catalog-index.mjs`. `loadCatalog` then drops the stale entry from the returned list and folds its primary + aliases into the canonical's alias list, so subsequent runs of every script land on the good entry.

### Ad-hoc lookups

```bash
# What's the catalog URL for these stars?
node scripts/lookup-star.mjs "Barnard's Star" "Rigil Kentaurus" "GJ 1227"

# Every catalog entry between 6 and 8 ly
node scripts/lookup-star.mjs --range=6,8

# Diff: which rows in a CSV are missing some field?
node scripts/lookup-star.mjs --csv=src/data/stars-25-30ly.csv --missing=class
```

## Notes

- **Cache**: `fill-from-stellarcatalog.mjs` writes each fetched HTML page to `.cache/stellarcatalog/<slug>.html`. Subsequent runs against the same star are instant. Delete the cache to force re-fetch.
- **Throttle**: defaults to 500ms between live fetches. Cache hits don't sleep. Lower for impatience, raise to be polite to stellarcatalog.com.
- **Name matching**: the shared library generates name variants (case + diacritics + GJ↔Gliese ↔ Greek-letter spellings + possessive forms + trailing-component-letter). When a lookup fails, the matcher's variant set is the first place to look — see `variants()` in `lib/catalog-index.mjs`.
- **Catalog file**: defaults to `~/Documents/catalog.html` (a saved copy of stellarcatalog.com's "all stars" listing). All scripts that read it accept `--catalog=PATH`.
