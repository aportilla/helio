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
const CATEGORY_ORDER: readonly ActionCategory[] = ['attack', 'support', 'navigation'];

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
  }

  get closed(): boolean {
    return this.done;
  }

  private get frame(): Frame {
    return this.stack[this.stack.length - 1]!;
  }

  // The top-level category rows, in CATEGORY_ORDER. If the actor declares a category PALETTE
  // the menu shows exactly those — always, greyed when empty (rows() marks enablement) — so a
  // body always offers Attack + Support even before it has a weapon. Absent ⇒ derive from the
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
      return this.categories().map((c) => ({
        key: c,
        label: categoryLabel(c),
        enabled: this.commandsIn(c).some((command) => this.canFire(command)),
      }));
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

  // Move the row cursor — categories or commands. INERT at the target level: the armed command
  // is frozen there (you change weapon by backing out, not while targeting).
  moveCursor(delta: number): void {
    if (this.done || this.frame.level === 'target') return;
    const n = this.rows().length;
    if (n === 0) return;
    this.frame.cursor = wrap(this.frame.cursor + delta, n);
  }

  setCursor(index: number): void {
    if (this.done || this.frame.level === 'target') return;
    const n = this.rows().length;
    if (index >= 0 && index < n) this.frame.cursor = index;
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
      this.stack.push({ level: 'command', cursor: 0, category: row.key as ActionCategory });
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
    case 'navigation': return 'Navigation';
  }
}

function wrap(i: number, n: number): number {
  return ((i % n) + n) % n;
}

function clamp(i: number, n: number): number {
  return i < 0 ? 0 : i >= n ? n - 1 : i;
}
