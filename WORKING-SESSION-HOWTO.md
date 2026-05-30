# Working Session How-To

A reusable playbook for running a structured, multi-agent problem-solving session in this
repo — the orchestrator-plus-disposable-subagents pattern, driven by a single living plan doc.

**How to invoke it.** Say something like *"read README.md and WORKING-SESSION-HOWTO.md and
create a plan for X"* → Claude runs **Phase 1** (research + write the plan doc). Later, *"begin
working the plan"* (or *"work the hitlist"*) → Claude runs **Phase 2** (execute it wave by wave,
verifying as it goes).

**When it's worth it.** A body of work with many semi-independent changes spread across many
files — a holistic-review hitlist, a refactor sweep, a migration, a doc-accuracy pass. The
overhead pays for itself when there's enough parallelizable work to fan out and enough subtlety
that each change needs independent verification.

**When it's *not* worth it.** A single-file change, a one-function bug, anything you'd finish
faster by just doing it. Don't stand up the whole apparatus for three edits.

---

## The shape of a session

Two phases, each with the human in the loop at the boundary:

1. **Plan** — research the codebase, then write a *living plan doc* that is the single source of
   truth for what's left, in flight, and done.
2. **Execute** — one orchestrator (the main session) dispatches disposable subagents in
   file-disjoint waves, verifies each result independently, and updates the doc. Repeat until
   every item is `VERIFIED` / `WONTFIX` / `DEFERRED`.

The orchestrator never disappears into the work. Its job is to **pick the next safe batch,
dispatch, verify completeness, update the doc, repeat** — not to write the fixes itself (beyond
trivial one-liners).

---

## Phase 1 — Create the plan doc

### Research first

- Read `README.md` and the relevant Architecture notes. Read the **actual current code** — do
  **not** infer intent from git history (line numbers and call sites drift; commit messages
  lie). When you cite a line number, treat it as a starting point to confirm against current
  code.
- Fan out read-only exploration if the surface is broad (the `Explore`/`general-purpose` agents
  are good for "sweep many files, return the conclusion"). Locate every discrete change the work
  implies.
- For each change, nail down five things before writing it up: **which file(s)** it touches,
  **what's wrong**, **why it matters**, **the fix**, and **how you'll know it's done**.

### Where the plan doc lives

`plans/<topic>-plan.md` — and `plans/` is **gitignored** (ephemeral working state; see the memory
rule "planning docs live in plans/"). Do **not** commit the plan doc. Only durable artifacts
(`README.md`, this file) are committed. The CSV/code diff is the permanent history; the plan doc
is scaffolding.

### Plan doc structure

Reproduce this skeleton (it's what made the last session legible):

```
# <Topic> — Living Plan

A one-paragraph statement of scope + the rule that this doc is the single source of truth,
updated as work lands.

## How to use this doc (operating protocol)
  - The orchestration model (orchestrator + disposable subagents; orchestrator verifies).
  - The hard rule: file disjointness for parallel dispatch.
  - Status legend.
  - The "updating an item when done" procedure.
  - The "verify completeness" definition (gates + acceptance + no collateral drift).
  - The subagent dispatch recipe (a fill-in template).

## Cold-start context (read this if picking up fresh)
  - What the repo is, the two/three halves under review, key invariants you can break by accident.

## Items
  Grouped into Tiers by kind (e.g. Bugs → Latent → Dead code → Docs → Reuse → Nits).
  Each item is one block (see "Writing a good item" below).

## Recommended wave plan (file-disjoint batches)
  A starting schedule; re-plan each wave against current Status.

## File → items conflict index
  | File | Items |  — the lookup table for disjointness.

## Progress log
  Append one line per dispatch/verification: `YYYY-MM-DD | WAVE | item(s) | agent | action`.
```

### Writing a good item

Every item is a self-contained block an orchestrator can paste straight into a subagent prompt:

```
#### <ID> — <one-line title>
- **Status:** TODO
- **Severity:** Bug | Latent | Reuse | Dead | Doc | Nit
- **Files:** `path/one`, `path/two`
- **Problem:** What's wrong, with concrete locations (file:line as a starting point).
- **Why it matters:** The cost of leaving it — or why it's low blast-radius.
- **Fix:** The intended change, specific enough to act on.
- **Acceptance criteria:** How "done" is proven — which gate to run, what grep must come back
  empty, whether output should change or stay byte-identical.
```

Give each item a **short stable ID** (B1, R3, DOC2…) so the conflict index and progress log can
reference it tersely. Order tiers so the safe, high-confidence work comes first and the risky,
wide-reaching refactors come last (see Wave order below).

### The File → items conflict index

A table mapping every file to the item IDs that touch it. This is the lookup for the
disjointness rule — before dispatching a parallel batch, confirm the batch's items don't collide
here. Keep it accurate as items are added or removed. A cross-file refactor claims **all** the
files it edits.

### The wave plan

A batched schedule honoring three constraints: **correctness first**, **refactors last on an
otherwise-clean tree**, **never two in-flight agents on one file**. Where one file hosts several
items, assign the **whole file to one agent** for that wave rather than splitting it across
batches. Re-plan each wave against current Status — the plan is a starting point, not a contract.

---

## Phase 2 — Execute

### The orchestration model

- **The orchestrator stays in the center.** It picks the next safe batch, dispatches subagents,
  reviews what comes back, **verifies completeness**, updates the doc, repeats. It writes fixes
  directly only when they're trivial one-liners faster to just do.
- **Subagents do the edits.** Each gets one item (or one file's worth of items) with full context
  lifted from the doc, makes the change, and reports what it did + how it checked. A subagent's
  "done" is a **claim**, not a fact.
- **Dispatch in parallel when genuinely non-overlapping.** Send a parallel batch as multiple tool
  calls in a single message so they run concurrently.

### File disjointness (the hard rule)

**Never have two in-flight subagents touch the same file** — they'll clobber each other. Before
dispatching a batch: look up every item's Files line, confirm the batch's file sets are
**pairwise-disjoint**, and split colliding items into different waves (or hand both to one agent
that does them sequentially). The conflict index is the lookup.

### Central gates — don't let agents race on the build

This repo's `predev`/`prebuild`/`pretypecheck` hooks fire `build:catalog`, which **writes the
shared, gitignored `src/data/catalog.generated.json`**. So *even `npm run typecheck` triggers a
build.* Two subagents running typecheck/build concurrently on the same working tree will race on
that file — one will catch the other mid-write and see a transient, confusing failure.

**The rule that fixes it:** instruct subagents to **edit + grep/read-only self-check only — do
NOT run `npm`/`node` build commands.** The **orchestrator owns all gates** and runs them
centrally, once, after a batch lands. This eliminated the race entirely. (`node --check` for a
pure syntax check is fine; it doesn't touch the build.)

### Subagent dispatch recipe

A template the orchestrator fills in per item:

> You are fixing one item in a Three.js + TypeScript + Node-procgen project at
> `/Users/adam/MyProjects/starmap`. Do NOT read git history; base everything on the current code.
> Read this codebase's conventions first (README "Coding conventions" + the relevant Architecture
> note) and honor them — pixel-crisp aesthetic, no `new` in tick loops, comments explain *why*
> not *what*, no legacy/"previously…" breadcrumbs, no numeric constants baked into docs. Do NOT
> commit. Do NOT run `npm`/`node` build commands — the orchestrator runs all gates centrally to
> avoid concurrent-build races; use grep/reading for self-checks.
>
> ITEM: <paste the full item block>
>
> For pure-extraction refactors: **transcribe each duplicated site verbatim first**, prove the
> extracted helper reproduces each site's result exactly (watch fallback semantics, rounding,
> seed/salt strings, inequality directions), and if you cannot prove a site is identical, **leave
> it inline and flag it** — output identity beats line-count reduction.
>
> Report back: (1) files changed + 1-line summary each, (2) your self-checks (grep output, exact
> reasoning), (3) anything you noticed but did NOT change. Touch only <the item's Files list>.

### Verify completeness — the orchestrator's real job

A fix is `VERIFIED` only when **all** hold:

- **It meets the item's Acceptance criteria.** Don't take the subagent's word — check it.
- **Gates are green** — run the relevant ones and *read the output*:
  - `npm run typecheck` for any `src/**.ts` change.
  - `npm run build:catalog` for any `scripts/**` change (note star/cluster/body counts so a count
    regression is visible).
  - `npm run check` — umbrella (build:catalog + tsc + audit-procgen) after procgen changes.
  - `npm run audit:procgen` / `npm run check:disk-physics` for distribution / disk-physics changes.
- **No collateral drift** — the change didn't introduce a new copy of something being removed,
  didn't leave a dangling comment, and (for refactors) **grep confirms every old inline copy is
  actually gone**, not just that the helper exists.
- **Determinism holds** where relevant — two consecutive `npm run build:catalog` runs produce a
  byte-identical JSON (`shasum -a 256 src/data/catalog.generated.json`, compare). A fix that
  *intentionally* changes output should have its delta confirmed as the *only* change (field-diff
  it), not a determinism break.

`DONE_PENDING_VERIFY` is a holding state, never an end state. Work is finished at `VERIFIED`.

### Status lifecycle & progress log

`TODO → IN_PROGRESS → DONE_PENDING_VERIFY → VERIFIED`, or `DEFERRED` / `WONTFIX` (record why).
After each dispatch and each verification, append one line to the Progress log. Update the item's
Status inline with a terse verification note (what you actually checked) so the doc always
reflects reality.

### Overriding the plan

Items are hypotheses, not orders. When investigation contradicts an item's premise, **say so and
do the right thing** — that's the orchestrator earning its keep. Real examples from the last
session:

- An item assumed a warning was "cosmetic given current priors"; it actually fired 37×. Rather
  than spam the build, the orchestrator investigated, found the cases benign, and **tightened the
  warning's guard** so it fires only on the genuinely harmful condition.
- A "collapse these duplicates" item was partly **left inline** because a fuzz test showed the two
  blend forms diverge at the bit level — converting would change tuned output.
- A "unify these two guards" item became **WONTFIX**: the supposedly-redundant guard actually
  protected a second branch, so unifying was a behavior change, not a pure extraction.

Record the override and its reasoning in the item — a `WONTFIX` with a good "why" is a finished
item.

---

## Repo gates & determinism cheat-sheet

```
npm run typecheck          # tsc --noEmit (runs build:catalog first via pretypecheck)
npm run build:catalog      # regenerate src/data/catalog.generated.json (gitignored)
npm run check              # umbrella: build:catalog + tsc + audit-procgen
npm run audit:procgen      # observed-vs-priors distribution audit (z-scores)
npm run check:disk-physics # disk-physics anchor regression gate
npm run inspect:body <id>  # pretty-print one body's post-procgen record (spot-checks)

# Determinism / byte-stability (run after any procgen change):
npm run build:catalog && shasum -a 256 src/data/catalog.generated.json   # run twice, compare hashes
```

`catalog.generated.json` and `plans/` are gitignored — they never enter a commit.

---

## Lessons baked in

- **Orchestrator owns the gates; subagents edit + grep-self-check only.** Concurrent builds race
  on the shared generated JSON (triggered even by typecheck).
- **Read current code, never git history.** Confirm every cited line number against the file.
- **Transcribe before refactoring.** For pure extractions, prove bit-for-bit equivalence per site
  (fallbacks, rounding, seed salts, inequality directions). If unsure, leave it inline and flag.
- **Byte-identical build is the strongest procgen check.** For intended-change items, field-diff
  to confirm only the expected fields moved.
- **One file, one agent per wave.** Assign a whole multi-item file to a single agent rather than
  serializing it across batches.
- **Verify-only nits ride along.** Fold a small nit into whichever agent already owns its file
  instead of spinning up a dedicated batch.
- **Correctness first, refactors last** on an otherwise-clean tree.
- **A subagent's "done" is a claim.** The orchestrator confirms it before `VERIFIED`.
- **Don't commit until asked**, then a single high-level commit unless told otherwise; no
  Co-Authored-By trailer (history shows the user only).
