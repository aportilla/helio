# Dev tooling & verification

How to check, inspect, and screenshot Helio locally — without ceremony. This is
the hub; the deep docs for each area are linked at the bottom.

## Verification — the "did I break it" sweep

| Command | What it does |
|---|---|
| `npm run check` | The umbrella gate — lint, build, type-check (app + tests), sim-boundary, and procgen-audit in sequence (see `scripts/check.mjs` for the authoritative order). Run after any data / schema / runtime change. |
| `npm test` | All unit suites — `test:sim` (the standalone economy sim) plus every app-side `test:*` suite (one per subsystem; see `package.json` for the roster). Run any one alone, e.g. `npm run test:sim`. |
| `npm run typecheck` | `tsc --noEmit` over `src/`. `npm run typecheck:sim` type-checks the standalone sim against its own stricter `tsconfig`. |
| `npm run build` | Full production build (`tsc && vite build`) — the strongest "does it bundle" signal. |
| `npm run check:boundaries` | Just the standalone-sim import wall (only `src/facilities/` may import `sim/`). Also part of `check`. |
| `npm run check:disk-physics` | Disk-physics anchor regression gate — exits non-zero if a frost-line / surface-density / isolation-mass anchor falls out of band. No catalog dependency. Run after touching the disk-physics priors. |

Catalog-specific inspectors and audits (`inspect:body`, `inspect:csv`,
`audit:procgen`, …) live in [scripts/README.md](../scripts/README.md).

## Linting

[oxc](https://oxc.rs)'s `oxlint` is the code linter — a single Rust binary,
correctness-only, configured in `.oxlintrc.json` (the source of truth for rules +
suppressions). It complements `tsc` rather than overlapping it: `tsc` owns types,
oxlint catches well-typed-but-suspicious patterns, and it's the only static
analysis the `.mjs` tooling layer gets. Three ways it runs:

| Entry point | When | What |
|---|---|---|
| `npm run lint` | Ad-hoc | Whole tree; `npm run lint:fix` applies the autofixable subset. |
| inside `npm run check` | Pre-commit / CI | A gating step near the top of the umbrella (fast, fails fast). CI runs `check` before `build`, so a finding blocks the deploy. |
| `.claude/hooks/oxlint-changed.mjs` | After every Claude edit | A PostToolUse hook (wired in `.claude/settings.json`) lints just the edited file and blocks back to the agent on a finding — "lint-on-save" for a Claude session, where editor extensions are useless because the editor *is* the agent. Fails open if oxlint can't run. |

Suppressions are deliberate and rationale-commented in `.oxlintrc.json` — no blanket
disables. The standalone-sim import wall stays owned by
`scripts/check-sim-boundary.mjs`, not oxlint (its `import` plugin is too
false-positive-prone for path-based zones).

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
npm run screenshot -- --query=demo-route              # the gold warp banner + route line
```

`scripts/screenshot.mjs` boots the Vite dev server **in-process** (with
`server.open` forced off, so nothing pops up), drives a headless Chromium
(puppeteer) to the galaxy view, waits for the WebGL canvas to settle (the scene
auto-selects Sol and warms shaders), and writes a PNG. Output lands in
`screenshots/` (gitignored). Flags: `--out`, `--width`, `--height`, `--wait` (ms),
`--query` (append a DEV boot-state query — `demo-encounter` for the combat overlay,
`demo-warp` for the in-system warp chrome, `demo-route` for the galaxy departure pick
with a destination locked so the gold banner + route line are captured).

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
