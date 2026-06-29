// The action vocabulary's small central remainder after the inversion. There is no longer a
// central ACTION_DEFS registry — an action's design is an ActionGrant owned by the provider that
// grants it, and an actor's commands are DERIVED and merged (./derive). What stays central is
// only what isn't a provider grant: the per-actor-TYPE category palettes, and the display helpers
// the menu reads off a resolved command. Still a pure leaf — it imports only the vocabulary
// (./types).

import type { ActionCategory, ActionCommand } from './types.ts';

// The category PALETTES — the stable top-level row set per actor TYPE. Ships and bodies alike show
// Attack + Support + Command: the menu renders exactly the actor's palette (in CATEGORY_ORDER),
// greying any category its loadout leaves empty, so the menu's SHAPE is stable per type rather than
// per loadout. 'command' is a reserved placeholder — no module grants a command-category action yet,
// so it always renders greyed for now. Central here (not in the adapters) so the palettes read side
// by side. Kept as two named exports though equal today: ships and bodies may diverge (e.g. a ship
// regains Navigation once galaxy movement / flee lands; 'navigation' stays a valid, dormant category).
export const SHIP_CATEGORIES: readonly ActionCategory[] = ['attack', 'support', 'command'];
export const BODY_CATEGORIES: readonly ActionCategory[] = ['attack', 'support', 'command'];

// A resolved command's menu label — the grant's label, suffixed with its stack count when more
// than one identical provider merged (D2: `Missile (x3)`). The single source the menu row reads.
export function commandLabel(command: ActionCommand): string {
  return command.count > 1 ? `${command.grant.label} (x${command.count})` : command.grant.label;
}

// A resolved command's accent COLOR — the grant's literal sRGB hex (rendered verbatim, since
// ColorManagement is OFF). The menu row (and a later pill) read it; reserved today, like the
// pre-inversion actionColor.
export function commandColor(command: ActionCommand): string {
  return command.grant.color;
}
