// The action vocabulary's small central remainder after the inversion. There is no longer a
// central ACTION_DEFS registry — an action's design is an ActionGrant owned by the provider that
// grants it, and an actor's commands are DERIVED and merged (./derive). What stays central is
// only what isn't a provider grant: the per-actor-TYPE category palettes, and the display helpers
// the menu reads off a resolved command. Still a pure leaf — it imports only the vocabulary
// (./types).

import type { ActionCategory, ActionCommand } from './types.ts';

// The category PALETTES — the stable top-level row set per actor TYPE. A ship shows Attack (no flee ⇒
// no Navigation in combat; an encounter is fought to its terminal, never withdrawn), a body Attack +
// Support; the menu renders exactly the actor's palette (in CATEGORY_ORDER), greying any category its
// loadout leaves empty, so the menu's SHAPE is stable per type rather than per loadout. Central here (not
// in the adapters) so the two palettes read side by side. 'navigation' stays a valid ActionCategory,
// reserved for future in-combat repositioning / galaxy movement — re-add it to a palette when that lands.
export const SHIP_CATEGORIES: readonly ActionCategory[] = ['attack'];
export const BODY_CATEGORIES: readonly ActionCategory[] = ['attack', 'support'];

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
