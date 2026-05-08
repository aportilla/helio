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
| `lookup-star.mjs` | Resolve a star name (or distance range) to a stellarcatalog URL. Useful for ad-hoc poking. |
| `lib/catalog-index.mjs` | Shared helpers: catalog HTML parsing, name normalization + variant generation, CSV (de)serialization. Imported by the other scripts. |

The local stellarcatalog listing defaults to `~/Documents/catalog.html` (override with `--catalog=PATH` on any script that uses it). The cache for fetched detail pages lives at `.cache/stellarcatalog/` (gitignored).

## Common workflows

### Bootstrap a new distance bracket from the catalog

Best when the bracket is far enough out that Wikipedia's table is sparser than stellarcatalog's coverage (true from ~30 ly outward).

```bash
# 1. Empty CSV with the canonical header
echo "name,distance_ly,constellation,ra_deg,dec_deg,spectral_class,mass_msun,app_mag,abs_mag,parallax_mas" \
  > src/data/stars-40-45ly.csv

# 2. Append every catalog star in [40, 45] ly (range inferred from filename)
node scripts/find-missing-stars.mjs --csv=src/data/stars-40-45ly.csv --add

# 3. Fetch each detail page and fill RA/Dec, mass, magnitudes, etc.
node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-40-45ly.csv --needs=any

# 4. Wire into src/data/stars.ts:
#    - add `import fortyFortyFiveCsv from './stars-40-45ly.csv?raw';`
#    - add `{ text: fortyFortyFiveCsv, label: 'stars-40-45ly.csv' }` to the sources array

# 5. Update README's project layout to mention the new file
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

# 4. Wire into stars.ts as above
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
