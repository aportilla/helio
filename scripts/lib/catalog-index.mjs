// Shared helpers for parsing the local stellarcatalog.com listing
// (~/Documents/catalog.html) and matching star names against it. Used by
// both scripts/lookup-star.mjs (URL lookup) and
// scripts/fill-from-stellarcatalog.mjs (auto-fill missing CSV fields).

import { readFileSync } from 'node:fs';

export const CATALOG_BASE_URL = 'https://www.stellarcatalog.com';

// Each star row in the source HTML looks like:
//   <tr class=''>
//     <td class=''><a href='stars/foo'>Primary Name<div class='note' style=''>alias1, alias2, ...</div></a></td>
//     <td class='number'><span class='value'>27.2</span> ly</td>
//   </tr>
// The schema is rigid — regex is sufficient and avoids pulling in a parser.
const ROW_RE = /<a href='(stars\/[^']+)'>([^<]*)(?:<div class='note'[^>]*>([^<]*)<\/div>)?<\/a>[\s\S]*?<span class='value'>([^<]+)<\/span>/g;

// Catalog duplicates: the same physical star listed under two slugs, where
// one of the entries has corrupt detail-page data (wrong RA/Dec/distance).
// Map the stale slug → the canonical one. `loadCatalog` then:
//   - drops the stale entry from the returned list (find-missing-stars
//     won't double-count it; expand-systems won't hit its broken page)
//   - merges the stale entry's primary + aliases into the canonical's alias
//     list (so findStar can still reach the canonical from a CSV row that
//     happens to use the stale entry's name)
//
// Currently known: wise-2220-3628's detail page has fields zeroed out
// ("0h 22m 20.000s" instead of the slug-encoded "22h 20m 55s", "0°28'17.4"
// instead of "-36°28'17.4"); wise-j22205531-3628174 is the correct entry.
const STALE_SLUG_REDIRECTS = new Map([
  ['stars/wise-2220-3628', 'stars/wise-j22205531-3628174'],
]);

export function loadCatalog(path) {
  const html = readFileSync(path, 'utf8');
  const stars = [];
  // First pass: collect stale entries' names so we can fold them in as
  // aliases of their canonical. Two-pass because the stale and canonical
  // may appear in either order in the source HTML.
  const staleNamesByCanonical = new Map();
  for (let m; (m = ROW_RE.exec(html)); ) {
    const [, slug, primary, aliasesStr] = m;
    const canon = STALE_SLUG_REDIRECTS.get(slug);
    if (!canon) continue;
    const aliases = aliasesStr ? aliasesStr.split(',').map(s => s.trim()).filter(Boolean) : [];
    const queue = staleNamesByCanonical.get(canon) ?? [];
    queue.push(primary.trim(), ...aliases);
    staleNamesByCanonical.set(canon, queue);
  }
  ROW_RE.lastIndex = 0;
  for (let m; (m = ROW_RE.exec(html)); ) {
    const [, slug, primary, aliasesStr, distStr] = m;
    if (STALE_SLUG_REDIRECTS.has(slug)) continue;  // skip the stale entry itself
    const aliases = aliasesStr ? aliasesStr.split(',').map(s => s.trim()).filter(Boolean) : [];
    const staleAliases = staleNamesByCanonical.get(slug);
    if (staleAliases) aliases.push(...staleAliases);
    const distLy = Number(distStr);
    stars.push({
      primary: primary.trim(),
      aliases,
      slug,
      url: `${CATALOG_BASE_URL}/${slug}`,
      distLy: Number.isFinite(distLy) ? distLy : null,
    });
  }
  return stars;
}

// Normalize for index keys / lookup queries.
export function normalize(s) {
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // strip diacritics (Boötis → Bootis, Müller → Muller)
    .replace(/[−–—]/g, '-')                   // unicode minus, en-dash, em-dash → hyphen
    .replace(/['`’]/g, '')                    // strip apostrophes / backticks
    .replace(/\([^)]*\)/g, '')                // drop parentheticals (catalog adds "(B)" etc.)
    .replace(/\s+/g, ' ')
    .trim();
}

// Common designation interchanges. The catalog often lists e.g. "Gliese 1227"
// without a "GJ 1227" alias even though they're the same star; cover the
// frequent spellings so name-from-our-CSV lookups don't whiff on convention
// drift.
const SUBS = [
  [/\bGJ\b/i,        'Gliese'],
  [/\bGliese\b/i,    'GJ'],
  [/\bAlpha\b/i,     'α'],
  [/α/g,             'Alpha'],
  [/\bBeta\b/i,      'β'],
  [/β/g,             'Beta'],
  [/\bGamma\b/i,     'γ'],
  [/γ/g,             'Gamma'],
  [/\bEpsilon\b/i,   'ε'],
  [/ε/g,             'Epsilon'],
  [/\bDelta\b/i,     'δ'],
  [/δ/g,             'Delta'],
  [/\bSigma\b/i,     'σ'],
  [/σ/g,             'Sigma'],
];

export function variants(name) {
  const out = new Set([normalize(name)]);
  // Possessive variant: catalog editors are inconsistent — some entries
  // drop both the apostrophe AND the trailing s ("Barnard's Star" → "Barnard
  // star"), others keep the s ("Luyten's Star" → "Luytens Star"). Generate
  // both forms so either spelling matches.
  if (/'s\b/i.test(name)) out.add(normalize(name.replace(/'s\b/gi, '')));
  // Component-letter suffix variant: "Gliese 299 A" should match "Gliese 299"
  // and vice versa (Wikipedia and the catalog disagree about whether the
  // primary of a single-known-companion pair gets a bare designation or an
  // " A"). Generate both forms.
  if (/\s+[A-Z][a-z]?$/.test(name)) out.add(normalize(name.replace(/\s+[A-Z][a-z]?$/, '')));
  for (const [re, repl] of SUBS) {
    if (re.test(name)) out.add(normalize(name.replace(re, repl)));
  }
  return out;
}

export function buildIndex(stars) {
  const index = new Map(); // normalized name → star (first wins on collision)
  for (const s of stars) {
    for (const v of variants(s.primary)) {
      if (!index.has(v)) index.set(v, s);
    }
    for (const a of s.aliases) {
      for (const v of variants(a)) {
        if (!index.has(v)) index.set(v, s);
      }
    }
  }
  return index;
}

export function findStar(index, query) {
  for (const v of variants(query)) {
    const hit = index.get(v);
    if (hit) return hit;
  }
  return null;
}

// ---------- detail-page component sections ----------
//
// A catalog detail page (e.g. https://www.stellarcatalog.com/stars/fomalhaut-a)
// has one <h2 class='title'> section per stellar component:
//   <h2 class='title'>Fomalhaut</h2>
//   <h2 class='title'>Fomalhaut B</h2>
//   <h2 class='title'>Fomalhaut C</h2>
// Each section's body carries spectral class, mass (as a percentage of solar
// mass), and V-band magnitudes. Catalog index entries are one-per-system so
// sibling rows in our CSVs (fomalhaut-b, fomalhaut-c) all resolve to the
// primary's slug — we MUST scope per-component reads to the right section,
// or every sibling inherits the primary's values.
//
// Sibling rows in our CSVs encode their component letter in the `id` column:
//   gamma-leporis-b → letter "B"
// `parseComponentSections` returns one block per section with a resolved
// `letter`, so the caller can pair `id`-letter ↔ section-letter directly
// without name-matching heuristics. Letter resolution mirrors the canonical
// slug convention so a row's id-letter and its section's letter agree even
// when the section uses a non-suffixed display name (Gamma Leporis B is
// listed as "AK Leporis" — its variable-star designation — and gets letter
// B by exclusion of A).

const SPECTRAL_RE = /Spectral class:\s*<span[^>]*>\s*([^<]+?)\s*<\/span>/;
const MASS_PCT_RE = /Mass:\s*<span[^>]*>\s*([\d.]+)\s*%\s*<\/span>/;
const APP_MAG_V_RE = /Apparent magnitude \(V\):\s*<span[^>]*>\s*([-−–\d.]+)\s*</;
const ABS_MAG_V_RE = /Absolute magnitude \(V\):\s*<span[^>]*>\s*([-−–\d.]+)\s*</;

function numFromMag(s) {
  if (s == null) return null;
  const v = Number(s.replace(/[−–]/g, '-'));
  return Number.isFinite(v) ? v : null;
}

export function parseComponentSections(html, primaryName, primarySlug) {
  // Stop at "Other neighborhood stars" — that section also uses h2.title for
  // unrelated nearby stars, which would otherwise look like extra components.
  const stopIdx = html.search(/Other neighborhood stars|<h1 class='title'/);
  const slice = stopIdx > 0 ? html.slice(0, stopIdx) : html;
  const matches = [...slice.matchAll(/<h2 class='title'>([^<]+)<\/h2>/g)];
  if (!matches.length) return [];

  const blocks = matches.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : slice.length;
    return { name: m[1].trim(), body: slice.slice(start, end) };
  });

  // Resolve component letters. Two passes:
  //   1. Try to extract the letter from each section's display name —
  //      either as a suffix relative to the primary name ("Fomalhaut B"
  //      → "B") or as a trailing single/double-letter group ("V1054
  //      Ophiuchi Ba" → "Ba").
  //   2. Any block we couldn't extract a letter from gets the next unused
  //      single letter — handles the case where the catalog uses an IAU
  //      proper name in lieu of a component letter ("AK Leporis" for
  //      Gamma Leporis B; "Proxima Centauri" for Alpha Centauri C).
  // Subcomponent letters (Ba, Bb, Aa, Ab) implicitly claim their parent
  // letter — "B" can't be a separate slot if "Ba" + "Bb" already split it.
  const slugLetterMatch = /-([a-z]{1,2})$/.exec(primarySlug ?? '');
  const primaryLetter = slugLetterMatch
    ? slugLetterMatch[1].charAt(0).toUpperCase() + slugLetterMatch[1].slice(1)
    : 'A';
  const claimed = new Set();
  for (const b of blocks) {
    let letter = '';
    if (b.name === primaryName) letter = primaryLetter;
    else if (primaryName && b.name.startsWith(primaryName + ' ')) {
      letter = b.name.slice(primaryName.length + 1).trim();
    } else {
      const m = /\s+([A-Z][a-z]?)$/.exec(b.name);
      if (m) letter = m[1];
    }
    if (letter) claimed.add(letter);
    b.letter = letter;
  }
  for (const c of [...claimed]) if (c.length === 2) claimed.add(c[0]);
  for (const b of blocks) {
    if (b.letter) continue;
    for (const c of 'BCDEFGHIJKLMNOPQRSTUVWXYZ') {
      if (!claimed.has(c)) { b.letter = c; claimed.add(c); break; }
    }
  }

  // Per-section fields. Mass is parsed from the "X %" display (correct
  // per-component); the catalog's prose narrative ("Mass of the star X is
  // N.NN solar masses") is buggy — it copies the prior section's mass into
  // each subsequent section. The percentage display is reliable.
  for (const b of blocks) {
    const cls = SPECTRAL_RE.exec(b.body);
    const massPct = MASS_PCT_RE.exec(b.body);
    const appV = APP_MAG_V_RE.exec(b.body);
    const absV = ABS_MAG_V_RE.exec(b.body);
    b.spectralClass = cls ? cls[1].trim() : null;
    b.mass = massPct && Number.isFinite(Number(massPct[1])) ? Number(massPct[1]) / 100 : null;
    b.appMagV = numFromMag(appV ? appV[1] : null);
    b.absMagV = numFromMag(absV ? absV[1] : null);
  }
  return blocks;
}

// Extract the trailing component letter from a canonical id (e.g.
// "fomalhaut-b" → "B", "v1054-ophiuchi-ba" → "Ba"). Returns null if the id
// has no letter suffix (single-star slug like "vega").
export function letterFromId(id) {
  const m = /-([a-z]{1,2})$/.exec(id ?? '');
  if (!m) return null;
  return m[1].charAt(0).toUpperCase() + m[1].slice(1);
}

// Minimal CSV parser — RFC-4180-ish. We control the upstream format so we
// don't worry about exotic quoting or BOMs.
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQ = false;
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function csvEscape(v) {
  if (v == null || v === '') return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function serializeCsv(rows) {
  return rows.map(r => r.map(csvEscape).join(',')).join('\n') + '\n';
}
