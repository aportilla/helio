# Documentation style

How we write docs and comments so they stay true as the code moves. The goal
isn't *more* documentation — it's documentation that **doesn't drift** (drift
quietly erodes trust in every other line) and **doesn't fossilize** (a doc that
re-litigates settled or abandoned choices adds friction the next time we want to
change our minds). Both point the same way: describe **what is**, in its own terms.

## The core idea: write to the slow-changing layer

Every sentence in a doc sits in one of three tiers, and they rot at very
different rates. Knowing which tier you're writing tells you how to write it.

| Tier | What it is | Examples | How to treat it |
|---|---|---|---|
| **Intent** | *Why* the current design is the way it is | a load-bearing constraint, a boundary's rationale, the reason a value or invariant must stay put | **Maximize** — but in the design's *own* terms (see "Describe what *is*" below). This is what docs are *for*, and it barely drifts — intent outlives implementation. |
| **Structural** | The shape of the system | module layout, data flow, dependency direction, which layer owns what | Keep, but keep **coarse**. Describe the shape and link to the code; don't mirror it line-by-line. Drifts only on a real refactor. |
| **Derived facts** | Values the code already owns | constant values, counts, exhaustive symbol/file lists, line numbers, signatures | **Eliminate, link, or let a tool report it.** This tier is where drift lives. Never bake a derived fact into prose. |

Most of our docs are strong because they're rich in **Intent**. The drift we
find is almost always a **Derived fact** that leaked into the prose.

## Describe what *is*, in its own terms

A doc describes the design that exists now and the design that's coming — nothing
else. Two things never belong, even dressed up as rationale:

- **The road not taken.** Don't preserve rejected alternatives, an approach we
  considered and dropped, or "X beats Y" comparisons. Roads-not-taken read as a
  standing commitment to re-litigate, and they add friction the moment we want to
  experiment or change our minds. Give the current design's *own* reason (the
  constraint it lives under, the invariant it protects) — not the option it beat.
- **The prior state.** Don't frame the current design as a diff against what came
  before it ("formerly one level," "replaces the old triangle," "reshaped from two
  menus"). A reader who never saw the old version gets only dead weight; state the
  present shape directly. (Rule 4 restates this for the drift-fast tier.)

Keep the *why* — but a why that stands on its own ("three sequential levels so Esc
walks back one at a time"), never one that only parses against code that no longer
exists ("three levels now, instead of the two we used to have").

## Rules for the drift-fast tier

1. **No magic numbers — name the symbol.** Write `DISC_SCALE`, not its value.
   Tuning a constant must never invalidate a doc. (See [[feedback_no_constants_in_docs]].)
2. **No counts.** Don't write "N tests" / "N rows" / "N clusters" / "the four
   checks." Either omit the number or note that the tool self-reports it
   (`npm test` prints the count). A tally is wrong the instant the set changes.
3. **No exhaustive lists the code already maintains.** State the *rule* and give
   one or two illustrative examples — don't claim a complete set. "The curated
   rows whose display name diverges from IAU" survives; "(Toliman, Keid, …) —
   eight rows" does not.
4. **Present tense, current state only.** No "will be wired," "formerly X,"
   "used to." Describe what *is*, and why. (See [[feedback_no_legacy_breadcrumbs_in_comments]].)
5. **No line numbers in prose.** Reference a symbol or section name — it survives
   edits; a line number rots on the next insertion.
6. **One fact, one home — link, don't restate.** A fact lives in exactly one
   doc; everywhere else points to it. The root README is a hub into co-located
   subsystem docs, not a copy of them. (See [[feedback_doc_structure]].)

## What to write instead

Spend the words on the tier that lasts:

- The **why** behind a boundary, not a restatement of the boundary.
- The **constraint** a future change must not break ("ColorManagement is OFF
  because…"), not the mechanics it's enforced by.
- The **constraint the current design lives under** ("`n` is bounded < 10, so the
  O(n²) scan is fine") — the reason its present shape is load-bearing, in its own
  terms. Not the alternative it beat: describe what *is*, not the road not taken.
- For comments specifically: explain the surprising *why* (the bug it works
  around, the FP-jitter it avoids), never restate what the code plainly does.

## Anti-drift by construction

The most durable defense is to make a fact unable to drift in the first place:

- **Generate or self-report it.** Let the test runner print its own count; let a
  `--help` print its own flags. A doc that says "run X to see Y" can't go stale
  about Y.
- **Pin it with a check.** Where a contract matters, encode it so CI fails on
  drift rather than a doc going quietly wrong. We already do this in code — the
  `assertBodyShape` emit guard, the `FROZEN_FACILITY_IDS` superset test, the
  `font-provider` DEV drift check, `check-sim-boundary`. When a doc claim is
  load-bearing, prefer turning it into one of these over trusting prose.

## A quick checklist

Before committing a doc or a doc-comment, scan for:

- [ ] Any bare number that isn't a symbol name? → name the symbol, or cut it.
- [ ] Any count or "complete list"? → state the rule, or let the tool report it.
- [ ] Any "will / formerly / used to / currently"? → rewrite as present state.
- [ ] Any rejected alternative, "X beats Y," or "replaces the old Z"? → cut it; describe only what is.
- [ ] Any line-number or restated-from-elsewhere fact? → reference / link instead.
- [ ] Is the sentence **why**, or just a slower restatement of **what**? → keep
      the why, cut the restatement.
