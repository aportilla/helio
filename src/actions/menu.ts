// ActionMenu — the mechanics-agnostic state machine behind the anchored, hierarchical
// system action menu. A rules/DTO type both src/ui/ and the scene controller may read (it
// imports nothing from scene/ or the DOM). THREE sequential levels:
//
//     category → command (weapon)  →  target
//
// The two phases are deliberately SEPARATE, not two axes of one level: you first choose WHAT
// to do (drill a category, pick a command), and only after arming a command do you scope into
// TARGET selection — a distinct mode where a focus marker rides one candidate in the field and
// the directional keys move it. Confirming at the target level FIRES the armed command at the
// locked target; nothing fires before then. `back` walks the hierarchy back up one level at a
// time (target → command → category → cancel). There is no target axis on the command level —
// the marker only appears once you've entered targeting. See ./README.md.

import type { Actor, ActionCategory, ActionCommand, ActionIntent, TargetCandidate, TargetCriteria } from './types.ts';
import { commandLabel } from './registry.ts';

export type MenuLevel = 'category' | 'command' | 'target';

// Who a command may point at, supplied by the controller (which alone knows real sides and
// real bodies). It mints the FULL candidate set as rich descriptors; the menu then SELECTS
// among them with the command grant's own TargetCriteria (filterCandidates below). 'self'
// targeting is resolved internally to [actor], never through this.
export type TargetResolver = (command: ActionCommand, actor: Actor) => readonly TargetCandidate[];

// The pure target matcher — a grant's TargetCriteria applied to the controller's minted
// candidates (absent criteria ⇒ permissive, every candidate). Factored out and exported so
// it is node-tested directly and so ships-as-targets and bodies-as-targets fall out as
// different predicate results of ONE pass, never two code paths. It SELECTS only; the menu
// maps the survivors to ids and `targeting` cardinality decides how many commit.
export function filterCandidates(
  candidates: readonly TargetCandidate[],
  criteria: TargetCriteria | undefined,
  actor: Actor,
): readonly TargetCandidate[] {
  if (!criteria) return candidates;
  return candidates.filter((c) => criteria(c, actor));
}

export interface MenuRow {
  readonly key: string;
  readonly label: string;
  readonly enabled: boolean;
}

export interface MenuView {
  readonly level: MenuLevel;
  readonly actorId: string;
  readonly rows: readonly MenuRow[];
  readonly cursor: number; // vertical: index into rows (the armed command, frozen at the target level)
  readonly selectedCategory?: ActionCategory; // set at the command + target levels
  // The live target axis (TARGET level only). `targets` are the candidate target ids (ship or
  // body) the armed command admits; `targetCursor` is the locked one — the controller marks
  // `targets[targetCursor]` in the field. Empty `targets` = nothing to fire at. The command level
  // deliberately exposes NO targets: targeting is its own later step.
  readonly targets?: readonly string[];
  readonly targetCursor?: number;
  readonly closed: boolean;
}

// Fixed display order for the top-level categories — stable so a ship's menu never reshuffles.
// 'navigation' trails (dormant — on no palette today) so its position never perturbs the live rows.
const CATEGORY_ORDER: readonly ActionCategory[] = ['attack', 'support', 'command', 'navigation'];

type Frame =
  | { level: 'category'; cursor: number }
  | { level: 'command'; cursor: number; category: ActionCategory }
  // The target frame freezes the armed command (`cursor`, within its category) and carries the
  // live target lock. The command stays selected — `back` returns to it untouched.
  | { level: 'target'; cursor: number; category: ActionCategory; targetCursor: number };

export class ActionMenu {
  private readonly actor: Actor;
  private readonly resolveTargets: TargetResolver;
  private stack: Frame[] = [{ level: 'category', cursor: 0 }];
  private done = false;

  constructor(actor: Actor, resolveTargets: TargetResolver) {
    this.actor = actor;
    this.resolveTargets = resolveTargets;
    // Open on the first DRILLABLE category, not blindly row 0 — the pointer must never rest on a
    // greyed row (e.g. a ship whose Attack is greyed for want of a target opens on a live category).
    this.stack[0]!.cursor = firstEnabledIndex(this.rows());
  }

  get closed(): boolean {
    return this.done;
  }

  private get frame(): Frame {
    return this.stack[this.stack.length - 1]!;
  }

  // The top-level category rows, in CATEGORY_ORDER. If the actor declares a category PALETTE
  // the menu shows exactly those — always, greyed when empty (rows() marks enablement) — so a
  // ship/body always offers Attack + Support + Command even before it carries a granting module. Absent ⇒ derive from the
  // categories the actor's commands actually span (the original behavior). Either way the order
  // is CATEGORY_ORDER, so the menu never reshuffles.
  private categories(): readonly ActionCategory[] {
    if (this.actor.categories) {
      const palette = this.actor.categories;
      return CATEGORY_ORDER.filter((c) => palette.includes(c));
    }
    const present = new Set<ActionCategory>();
    for (const command of this.actor.commands) present.add(command.grant.category);
    return CATEGORY_ORDER.filter((c) => present.has(c));
  }

  private commandsIn(category: ActionCategory): readonly ActionCommand[] {
    return this.actor.commands.filter((c) => c.grant.category === category);
  }

  // The actor's rootLevel commands — direct rows at the TOP (category) level, AFTER the category palette
  // (so a root verb like WARP DRIVE trails Attack/Support/Command). A root command sits under no category
  // row; arming it skips the command level and goes straight into targeting.
  private rootCommands(): readonly ActionCommand[] {
    return this.actor.commands.filter((c) => c.grant.rootLevel === true);
  }

  // The rootLevel command a category-level row key names, or null for a category row (whose key is an
  // ActionCategory string, never a composed command id). This distinguishes the two kinds of row that
  // share the heterogeneous category level — the one fork enter() needs at the top level.
  private rootCommandFor(key: string): ActionCommand | null {
    return this.actor.commands.find((c) => c.id === key && c.grant.rootLevel === true) ?? null;
  }

  // A command is available iff the actor can pay its energy cost (D6). ABSENT energy ⇒
  // permissive: the bones carry no energy model yet (no `stats.energy`), so every command is
  // available, exactly as before the inversion. The Phase-2 energy model populates `energy` and
  // greys a command the actor can't afford — no menu change needed.
  private isAvailable(command: ActionCommand): boolean {
    const energy = this.actor.stats?.energy;
    return energy === undefined || energy >= command.totalCost;
  }

  // A command can FIRE iff the actor can afford it AND it has at least one admissible target. The
  // two unfireable conditions grey it identically — so the menu never ARMS a weapon that would
  // strand the player at an empty target level (a 'self' command always has the actor, so it is
  // gated by affordability alone). This is what `enabled` means for a command row.
  private canFire(command: ActionCommand): boolean {
    return this.isAvailable(command) && this.candidatesFor(command).length > 0;
  }

  // The candidate target ids the armed command admits. 'self' resolves to the actor (the focus
  // marker lands on the acting entity itself — your own ship or body). Otherwise the controller
  // mints ALL candidates and the grant's TargetCriteria selects among them (absent ⇒ permissive);
  // the view/commit work in plain ids, so the survivors are mapped to their ids here.
  private candidatesFor(command: ActionCommand): readonly string[] {
    if (command.grant.targeting === 'self') return [this.actor.id];
    return filterCandidates(this.resolveTargets(command, this.actor), command.grant.targets, this.actor).map((c) => c.id);
  }

  // The command under the current frame's command cursor — defined on the command level (being
  // chosen) AND the target level (armed, frozen). Null off both / out of range.
  private cursoredCommand(): ActionCommand | null {
    const f = this.frame;
    if (f.level !== 'command' && f.level !== 'target') return null;
    return this.commandsIn(f.category)[f.cursor] ?? null;
  }

  private currentCandidates(): readonly string[] {
    const command = this.cursoredCommand();
    return command ? this.candidatesFor(command) : [];
  }

  // The rows at the current level. Category → the category palette; command/target → the
  // commands in the scoped category (the target level keeps showing them, with the armed one
  // frozen under the cursor, so the panel reads "firing <weapon>" while you target).
  private rows(): readonly MenuRow[] {
    const f = this.frame;
    if (f.level === 'category') {
      const categoryRows = this.categories().map((c) => ({
        key: c,
        label: categoryLabel(c),
        enabled: this.commandsIn(c).some((command) => this.canFire(command)),
      }));
      // The heterogeneous top level: the category palette THEN the actor's rootLevel commands as direct
      // rows (WARP DRIVE trails as the last row). A root row greys by the SAME canFire as a command row,
      // so the pre-grey (nothing reachable) and the in-combat grey (no system candidate) fall out of one
      // gate — no new greying path.
      const rootRows = this.rootCommands().map((command) => ({
        key: command.id,
        label: commandLabel(command),
        enabled: this.canFire(command),
      }));
      return [...categoryRows, ...rootRows];
    }
    return this.commandsIn(f.category).map((command) => ({
      key: command.id,
      label: commandLabel(command),
      enabled: this.canFire(command),
    }));
  }

  view(): MenuView {
    const f = this.frame;
    const rows = this.rows();
    if (f.level === 'category') {
      return { level: 'category', actorId: this.actor.id, rows, cursor: f.cursor, closed: this.done };
    }
    if (f.level === 'command') {
      // No target axis yet — targeting is the next, separate level.
      return { level: 'command', actorId: this.actor.id, rows, cursor: f.cursor, selectedCategory: f.category, closed: this.done };
    }
    const candidates = this.currentCandidates();
    const targetCursor = candidates.length === 0 ? 0 : clamp(f.targetCursor, candidates.length);
    return {
      level: 'target',
      actorId: this.actor.id,
      rows,
      cursor: f.cursor,
      selectedCategory: f.category,
      targets: candidates,
      targetCursor,
      closed: this.done,
    };
  }

  // -- vertical (rows) --------------------------------------------------

  // Move the row cursor — categories or commands — SKIPPING disabled (greyed) rows, so the focus
  // pointer never lands on a row that can't be drilled (an empty category, an unfireable weapon).
  // Steps one ENABLED row in `delta`'s direction, wrapping; a no-op when no row is enabled, so a
  // fully-greyed level keeps a stable cursor. INERT at the target level: the armed command is
  // frozen there (you change weapon by backing out, not while targeting).
  moveCursor(delta: number): void {
    if (this.done || this.frame.level === 'target' || delta === 0) return;
    const rows = this.rows();
    if (rows.length === 0) return;
    this.frame.cursor = nextEnabledIndex(rows, this.frame.cursor, delta < 0 ? -1 : 1);
  }

  // Lock the cursor onto a specific row (a hover / click). Refuses a DISABLED row, so neither input
  // path can rest the focus pointer on a greyed item — the same guarantee moveCursor gives the keys.
  setCursor(index: number): void {
    if (this.done || this.frame.level === 'target') return;
    const rows = this.rows();
    if (index >= 0 && index < rows.length && rows[index]!.enabled) this.frame.cursor = index;
  }

  // -- horizontal (target lock, target level) ---------------------------

  moveTarget(delta: number): void {
    if (this.done) return;
    const f = this.frame;
    if (f.level !== 'target') return;
    const n = this.currentCandidates().length;
    if (n === 0) return;
    f.targetCursor = wrap(f.targetCursor + delta, n);
  }

  // Lock a specific target by id (a click on a candidate ship or body). No-op off the target level
  // or for a non-candidate id.
  setTargetById(id: string): void {
    if (this.done) return;
    const f = this.frame;
    if (f.level !== 'target') return;
    const i = this.currentCandidates().indexOf(id);
    if (i >= 0) f.targetCursor = i;
  }

  // -- navigation -------------------------------------------------------

  // Drill in one level: category → command, or command → target (arming the command and
  // auto-locking the first candidate). At the TARGET level it FIRES the armed command at the
  // locked target. Returns a committed intent only when a command fires; null when we drilled (or
  // the row is empty / unavailable).
  enter(): ActionIntent | null {
    if (this.done) return null;
    const f = this.frame;
    const rows = this.rows();
    const row = rows[f.cursor];
    if (!row) return null;

    if (f.level === 'category') {
      if (!row.enabled) return null;
      const rootCommand = this.rootCommandFor(row.key);
      if (rootCommand) {
        // A root-level command is a DIRECT action: arm it straight into targeting, skipping the command
        // level. Its own category holds it, so the existing target frame identifies it with no new frame
        // shape (cursoredCommand reads commandsIn(category)[cursor]). The chrome intercepts a
        // 'system'-space root command BEFORE this fires (its destination lives in another view), so in-app
        // warp never actually pushes this frame; the branch exists for test coherence + a 'local' root
        // command later.
        const category = rootCommand.grant.category;
        const cursor = this.commandsIn(category).indexOf(rootCommand);
        this.stack.push({ level: 'target', cursor, category, targetCursor: 0 });
        return null;
      }
      this.stack.push({ level: 'command', cursor: 0, category: row.key as ActionCategory });
      this.frame.cursor = firstEnabledIndex(this.rows()); // park on the first FIREABLE weapon
      return null;
    }
    if (f.level === 'command') {
      if (!row.enabled) return null; // an unaffordable weapon doesn't arm
      this.stack.push({ level: 'target', cursor: f.cursor, category: f.category, targetCursor: 0 });
      return null;
    }
    return this.commit(); // target level — fire
  }

  back(): void {
    if (this.done) return;
    if (this.stack.length > 1) this.stack.pop();
    else this.cancel();
  }

  cancel(): void {
    this.done = true;
  }

  // Explicit commit — fire the armed command at the locked target. Only the TARGET level can
  // commit; above it there is no armed command + locked target yet, so it is a no-op (you drill
  // into targeting first).
  confirm(): ActionIntent | null {
    if (this.done) return null;
    return this.frame.level === 'target' ? this.commit() : null;
  }

  private commit(): ActionIntent | null {
    const command = this.cursoredCommand();
    if (!command || !this.isAvailable(command)) return null;
    const candidates = this.candidatesFor(command);
    if (candidates.length === 0) return null; // nothing to fire at
    const targeting = command.grant.targeting;
    const targetIds =
      targeting === 'self' ? [this.actor.id]
      : targeting === 'all' || targeting === 'multi' ? [...candidates]
      : [candidates[clamp((this.frame as Extract<Frame, { level: 'target' }>).targetCursor, candidates.length)]!];
    this.done = true;
    return { actorId: this.actor.id, actionId: command.id, targetIds };
  }
}

function categoryLabel(category: ActionCategory): string {
  switch (category) {
    case 'attack': return 'Attack';
    case 'support': return 'Support';
    case 'command': return 'Command';
    case 'navigation': return 'Navigation';
  }
}

// The next ENABLED row index from `from`, stepping by `dir` (±1) and wrapping. Returns `from` when no
// other row is enabled, so a fully-greyed level keeps a stable cursor. The shared skip-disabled
// primitive behind moveCursor.
function nextEnabledIndex(rows: readonly MenuRow[], from: number, dir: number): number {
  const n = rows.length;
  for (let step = 1; step <= n; step++) {
    const i = wrap(from + dir * step, n);
    if (rows[i]!.enabled) return i;
  }
  return from;
}

// The first enabled row index (top-down), or 0 if none — where a freshly entered level parks the
// cursor so the focus pointer never OPENS on a greyed row.
function firstEnabledIndex(rows: readonly MenuRow[]): number {
  const i = rows.findIndex((r) => r.enabled);
  return i < 0 ? 0 : i;
}

function wrap(i: number, n: number): number {
  return ((i % n) + n) % n;
}

function clamp(i: number, n: number): number {
  return i < 0 ? 0 : i >= n ? n - 1 : i;
}
