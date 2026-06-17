# Dev tooling & verification

How to check, inspect, and screenshot Helio locally — without ceremony. This is
the hub; the deep docs for each area are linked at the bottom.

## Verification — the "did I break it" sweep

| Command | What it does |
|---|---|
| `npm run check` | The umbrella gate — lint, build, type-check (app + tests), sim-boundary, and procgen-audit in sequence (see `scripts/check.mjs` for the authoritative order). Run after any data / schema / runtime change. |
| `npm test` | All unit suites — `test:sim` (the standalone economy sim) plus the app-side `test:facilities` / `test:data` / `test:scene`. Run any one alone, e.g. `npm run test:sim`. |
| `npm run typecheck` | `tsc --noEmit` over `src/`. `npm run typecheck:sim` type-checks the standalone sim against its own stricter `tsconfig`. |
| `npm run build` | Full production build (`tsc && vite build`) — the strongest "does it bundle" signal. |
| `npm run check:boundaries` | Just the standalone-sim import wall (only `src/facilities/` may import `sim/`). Also part of `check`. |
| `npm run check:disk-physics` | Disk-physics anchor regression gate — exits non-zero if a frost-line / surface-density / isolation-mass anchor falls out of band. No catalog dependency. Run after touching the disk-physics priors. |

Catalog-specific inspectors and audits (`inspect:body`, `inspect:csv`,
`audit:procgen`, …) live in [scripts/README.md](../scripts/README.md).

## Headless sim / economy inspection

The economy sim and its projection seam run in **plain Node** — no browser, no
game save. Node 23.6+ strips TypeScript at runtime, so a short `node <file>.ts`
can import `sim/src/` and `src/facilities/` directly (the same modules the live
app uses) with **no loader and no dependencies**. Because the sim is
integer-deterministic, a Node run reproduces exactly what the app's engine does.

```bash
npm run inspect:economy                  # default scenario, 8 turns
npm run inspect:economy -- --turns=20 --reach=12
```

`scripts/inspect-economy.ts` boots the economy on the **real cluster geometry**
(read straight from `catalog.generated.json`), runs a small editable scenario of
producers/consumers, and prints the per-turn flow — `dispatched` / `delivered`,
per-planet stock, the read-surface edge flows, and any shortfalls. Use it to
sanity-check reach, intra- vs inter-cluster transfers, and shortfall reasons.
Edit the `SCENARIO` array in the script to inspect your own pattern.

**Reusable pattern:** for a one-off "does X actually flow / route / persist?"
check, copy that shape — `import { EconomyEngine, makeWorld, … } from '../sim/src/index.ts'`,
build a tiny world, `engine.step()`, and read `getReadDigest()` / `getInTransitTo()`.
Keep such probes throwaway (delete after); promote one to a committed
`scripts/*.ts` only when it earns being re-run.

## Screenshots

```bash
npm run screenshot                                    # → screenshots/galaxy.png
npm run screenshot -- --out=screenshots/wide.png --width=1920 --height=1080 --wait=4000
```

`scripts/screenshot.mjs` boots the Vite dev server **in-process** (with
`server.open` forced off, so nothing pops up), drives a headless Chromium
(puppeteer) to the galaxy view, waits for the WebGL canvas to settle (the scene
auto-selects Sol and warms shaders), and writes a PNG. Output lands in
`screenshots/` (gitignored). Flags: `--out`, `--width`, `--height`, `--wait` (ms).

- Needs the `puppeteer` devDependency; `npm install` fetches its Chromium binary.
  WebGL renders through headless Chromium's software path — no display required.
- Today it captures the **galaxy view** only. Driving into the system view or
  placing facilities before the shot needs scripted page interaction (click a
  star, click an Add pill) — a future enhancement.

## Where the deep docs live

- Catalog / procgen pipeline + its inspectors and audits → [scripts/README.md](../scripts/README.md)
- Economy sim internals + its test suite → [sim/README.md](../sim/README.md)
- Facility seam + the live economy bridge → [src/facilities/README.md](../src/facilities/README.md)
- Game mechanics, save-state model, roadmap → [docs/game-systems.md](game-systems.md)
