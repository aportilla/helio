// ActionMenu — the mechanics-agnostic state machine behind the anchored, hierarchical
// system action menu. A rules/DTO type both src/ui/ and the scene controller may read (it
// imports nothing from scene/ or the DOM). Two levels, plus an orthogonal target axis:
//
//     category → command          (and, at the command level, a live target LOCK)
//
// The Sea-of-Stars idiom: scoping into a category's command list IS the target-selection
// modality. While you move VERTICALLY through commands (a weapon list), you move
// HORIZONTALLY through the candidate targets — a 'select' bracket riding one enemy in the
// field, auto-locked on entry. Confirming a command fires it at the locked target. There is
// NO separate target tier; the target is shown in the field by the controller, never as a
// menu row. See ./README.md.

import type { Actor, ActionCategory, ActionDef, ActionIntent, TargetCandidate, TargetCriteria } from './types.ts';
import { ACTION_BY_ID, PASS_ACTION, actionLabel } from './registry.ts';

export type MenuLevel = 'category' | 'command';

// Who a command may point at, supplied by the controller (which alone knows real sides and
// real bodies). It mints the FULL candidate set as rich descriptors; the menu then SELECTS
// among them with the def's own TargetCriteria (filterCandidates below). 'self' targeting is
// resolved internally to [actor], never through this.
export type TargetResolver = (def: ActionDef, actor: Actor) => readonly TargetCandidate[];

// The pure target matcher — a def's TargetCriteria applied to the controller's minted
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
  readonly isPass: boolean; // the always-present decline verb (category level only)
}

export interface MenuView {
  readonly level: MenuLevel;
  readonly actorId: string;
  readonly rows: readonly MenuRow[];
  readonly cursor: number; // vertical: index into rows
  readonly selectedCategory?: ActionCategory; // set at the command level
  // The live target axis (command level only). `targets` are the candidate target ids (ship or body)
  // the cursored command admits; `targetCursor` is the locked one — the controller draws a
  // bracket on `targets[targetCursor]`. Empty `targets` = nothing to fire at.
  readonly targets?: readonly string[];
  readonly targetCursor?: number;
  readonly closed: boolean;
}

// Fixed display order for the top-level categories — stable so a ship's menu never reshuffles.
const CATEGORY_ORDER: readonly ActionCategory[] = ['attack', 'support', 'navigation'];

type Frame =
  | { level: 'category'; cursor: number }
  | { level: 'command'; cursor: number; category: ActionCategory; targetCursor: number };

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

  // The categories the actor's commands span, in CATEGORY_ORDER. Stable per actor.
  private categories(): readonly ActionCategory[] {
    const present = new Set<ActionCategory>();
    for (const ref of this.actor.commands) {
      const def = ACTION_BY_ID.get(ref.id);
      if (def) present.add(def.category);
    }
    return CATEGORY_ORDER.filter((c) => present.has(c));
  }

  private commandsIn(category: ActionCategory): readonly ActionDef[] {
    const defs: ActionDef[] = [];
    for (const ref of this.actor.commands) {
      const def = ACTION_BY_ID.get(ref.id);
      if (def && def.category === category) defs.push(def);
    }
    return defs;
  }

  private isAvailable(def: ActionDef): boolean {
    return def.isAvailable ? def.isAvailable(this.actor) : true;
  }

  // The candidate target ids the cursored command admits. 'self' resolves to the actor (the
  // bracket lands on the acting entity itself — your own ship or body). Otherwise the
  // controller mints ALL candidates and the
  // def's TargetCriteria selects among them (absent ⇒ permissive); the view/commit work in
  // plain ids, so the survivors are mapped to their ids here.
  private candidatesFor(def: ActionDef): readonly string[] {
    if (def.targeting === 'self') return [this.actor.id];
    return filterCandidates(this.resolveTargets(def, this.actor), def.targets, this.actor).map((c) => c.id);
  }

  // The def under the command-level cursor (or null off the command level / out of range).
  private cursoredCommand(): ActionDef | null {
    const f = this.frame;
    if (f.level !== 'command') return null;
    return this.commandsIn(f.category)[f.cursor] ?? null;
  }

  private currentCandidates(): readonly string[] {
    const def = this.cursoredCommand();
    return def ? this.candidatesFor(def) : [];
  }

  // The rows at the current level.
  private rows(): readonly MenuRow[] {
    const f = this.frame;
    if (f.level === 'category') {
      const rows: MenuRow[] = this.categories().map((c) => ({
        key: c,
        label: categoryLabel(c),
        enabled: this.commandsIn(c).some((d) => this.isAvailable(d)),
        isPass: false,
      }));
      rows.push({ key: PASS_ACTION, label: actionLabel(PASS_ACTION), enabled: true, isPass: true });
      return rows;
    }
    return this.commandsIn(f.category).map((d) => ({
      key: d.type,
      label: d.label,
      enabled: this.isAvailable(d),
      isPass: false,
    }));
  }

  view(): MenuView {
    const f = this.frame;
    const rows = this.rows();
    if (f.level === 'category') {
      return { level: 'category', actorId: this.actor.id, rows, cursor: f.cursor, closed: this.done };
    }
    const candidates = this.currentCandidates();
    const targetCursor = candidates.length === 0 ? 0 : clamp(f.targetCursor, candidates.length);
    return {
      level: 'command',
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

  moveCursor(delta: number): void {
    if (this.done) return;
    const n = this.rows().length;
    if (n === 0) return;
    this.frame.cursor = wrap(this.frame.cursor + delta, n);
  }

  setCursor(index: number): void {
    if (this.done) return;
    const n = this.rows().length;
    if (index >= 0 && index < n) this.frame.cursor = index;
  }

  // -- horizontal (target lock, command level) --------------------------

  moveTarget(delta: number): void {
    if (this.done) return;
    const f = this.frame;
    if (f.level !== 'command') return;
    const n = this.currentCandidates().length;
    if (n === 0) return;
    f.targetCursor = wrap(f.targetCursor + delta, n);
  }

  // Lock a specific target by id (a click on a candidate ship or body). No-op off the command level
  // or for a non-candidate id.
  setTargetById(id: string): void {
    if (this.done) return;
    const f = this.frame;
    if (f.level !== 'command') return;
    const i = this.currentCandidates().indexOf(id);
    if (i >= 0) f.targetCursor = i;
  }

  // -- navigation -------------------------------------------------------

  // Drill in (category → command, auto-locking the first target) or, at the command level,
  // FIRE the cursored command at the locked target. Returns a committed intent only when an
  // action resolves (Pass, or a fire); null when we just drilled a level.
  enter(): ActionIntent | null {
    if (this.done) return null;
    const f = this.frame;
    const rows = this.rows();
    const row = rows[f.cursor];
    if (!row) return null;

    if (f.level === 'category') {
      if (row.isPass) return this.commitPass();
      if (!row.enabled) return null;
      this.stack.push({ level: 'command', cursor: 0, category: row.key as ActionCategory, targetCursor: 0 });
      return null;
    }
    return this.commit(); // command level — fire
  }

  back(): void {
    if (this.done) return;
    if (this.stack.length > 1) this.stack.pop();
    else this.cancel();
  }

  cancel(): void {
    this.done = true;
  }

  // Explicit commit — fire the cursored command at the locked target (command level), or
  // commit Pass when the Pass row is cursored at the category level.
  confirm(): ActionIntent | null {
    if (this.done) return null;
    const f = this.frame;
    if (f.level === 'command') return this.commit();
    const row = this.rows()[f.cursor];
    return row?.isPass ? this.commitPass() : null;
  }

  private commit(): ActionIntent | null {
    const def = this.cursoredCommand();
    if (!def || !this.isAvailable(def)) return null;
    const candidates = this.candidatesFor(def);
    if (candidates.length === 0) return null; // nothing to fire at
    const targetIds =
      def.targeting === 'self' ? [this.actor.id]
      : def.targeting === 'all' || def.targeting === 'multi' ? [...candidates]
      : [candidates[clamp((this.frame as Extract<Frame, { level: 'command' }>).targetCursor, candidates.length)]!];
    this.done = true;
    return { actorId: this.actor.id, actionId: def.type, targetIds };
  }

  private commitPass(): ActionIntent {
    this.done = true;
    return { actorId: this.actor.id, actionId: PASS_ACTION, targetIds: [] };
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
