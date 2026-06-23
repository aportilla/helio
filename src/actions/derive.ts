// derive — the derive-and-merge projection at the heart of the inverted action model. An
// actor's command list is not enumerated; it is COLLECTED from the modular providers the actor
// carries (a ship's components, a body's facilities) and MERGED so identical providers stack
// into one scaled command. A pure leaf: it reads only the action vocabulary (./types), so both
// adapters (ships-to-actors, bodies-to-actors) share this one projection.
//
// The command id codec lives here too: a command's stable, serializable id is composed as
// `"<providerId>:<grant.key>"`. The provider id is the durable, frozen thing (a FacilityType,
// later a ShipComponentDef.id); the grant key disambiguates a multi-grant module. grantKeyOf is
// the inverse the app-side effect-handler registry keys on (the verb identity, provider-agnostic).

import type { Actor, ActionCommand, ActionGrant } from './types.ts';

// A platform's module as the projection sees it — a stable provider id plus the grants it owns.
// Both a (future) ShipComponentDef and a FacilityDef conform: each adapter maps its def to this
// minimal shape, so deriveCommands never imports a concrete registry. `grants` is optional so a
// provider that grants nothing (a chassis, a pure-economy facility) is a no-op here.
export interface GrantProvider {
  readonly id: string;
  readonly grants?: readonly ActionGrant[];
}

// The grant KEY out of a composed command id — the provider-agnostic verb identity ('mine' from
// 'mining-base:mine'). The app-side effect handlers key on this so a verb's effect is one entry
// regardless of which provider grants it. Splits on the LAST colon: a provider id MAY be
// namespaced (contain a colon — e.g. a future 'weapon:railgun' component id), but a grant key
// must NOT, so the suffix after the final colon is always exactly the key. A bare id with no ':'
// (the menu-injected `pass`) maps to itself. A node test pins every shipped grant key colon-free.
export function grantKeyOf(id: string): string {
  const i = id.lastIndexOf(':');
  return i < 0 ? id : id.slice(i + 1);
}

// Collect every provider's grants, MERGE identical ones (same composed id) into a single command
// carrying its stack `count`, and return them in first-seen order so a menu never reshuffles.
// Heterogeneous grants stay separate commands (different provider id OR different key ⇒ different
// merge key). A composed id maps to exactly ONE grant definition — the first seen is kept and a
// later collision only bumps the count, which is correct because a (provider id, grant key) pair
// uniquely names a grant within a registry (so colliding grants are the same object today).
// `totalCost = count × costPerUnit` is LINEAR for v1 (D7); the per-weapon scaling curve hooks in
// here when the Phase-2 energy model lands. Effect-free — it shapes WHICH commands exist and how
// they stack, never what firing one does.
export function deriveCommands(providers: readonly GrantProvider[]): readonly ActionCommand[] {
  const order: string[] = [];
  const groups = new Map<string, { grant: ActionGrant; count: number }>();
  for (const provider of providers) {
    for (const grant of provider.grants ?? []) {
      const id = `${provider.id}:${grant.key}`;
      const group = groups.get(id);
      if (group) {
        group.count += 1; // D2: identical providers stack into one scaled command
      } else {
        groups.set(id, { grant, count: 1 });
        order.push(id);
      }
    }
  }
  return order.map((id) => {
    const { grant, count } = groups.get(id)!;
    return { id, grant, count, totalCost: count * (grant.costPerUnit ?? 0) };
  });
}

// The actor's resolved command matching a committed intent's actionId, or undefined when none
// does — notably the menu-injected Pass (id 'pass'), which is not a provider command. The
// live-view dispatcher reads `.grant.kind` off this to fork immediate vs encounter; factored out
// (pure, no scene) so that fork is node-testable without a DOM. Pass / an unknown id ⇒ undefined ⇒
// the immediate path, which is correct (Pass simply ends a turn).
export function commandFor(actor: Actor, actionId: string): ActionCommand | undefined {
  return actor.commands.find((c) => c.id === actionId);
}
