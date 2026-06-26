// Immediate-action effect handlers — the app-side sink the live-view dispatch routes a
// confirmed 'immediate' ActionIntent into. SystemScene.onImmediate looks one up by the intent's
// GRANT KEY (grantKeyOf(intent.actionId) — the provider-agnostic verb identity, so a verb's effect
// is one entry no matter which provider granted it); a handler MUTATES the
// helio.game save (and later triggers the facility-edit reconcile chain so the diagram + economy
// re-read), which is exactly why these live app-side and NOT in the pure src/actions/ leaf.
//
// BONES: every handler is a well-commented NO-OP stub. M3 builds the ROUTING — confirm →
// dispatch by kind → handler keyed by grant key — not the mechanics. Each stub marks where its
// real world-mutation (and the reconcile that must follow it) will land. No mechanic is decided
// here.
//
// An 'immediate' action with no handler registered here (grant keys like repair / recon — verbs
// that resolve elsewhere) falls through to SystemScene's DEV placeholder log. A grant key shared by
// two distinct 'immediate' providers MUST mean the same world effect (the map is provider-agnostic);
// when real effects land, a provider-specific verb routes by the full composed id instead.
//
// SEAM CONTRACT for the real handlers: intent.targetIds carry ENTITY ids, not raw save keys.
// A body target is entity-id-encoded ('body:<bodyIdx>') and a self-targeted body verb's
// target is the actor's own body id — so decode with parseEntityId(id) → bodyIdx →
// BODIES[bodyIdx].id before keying game-state (facilities/ownership) by raw Body.id, exactly
// as system-scene's slotCenterForEntity / pickForActorId already do. A ship target is the
// bare Ship.id.

import type { ActionIntent } from '../../actions/types';

export type EffectHandler = (intent: ActionIntent) => void;

// Keyed by GRANT KEY (not the full command id) so a verb's effect is provider-agnostic.
export const EFFECT_HANDLERS: ReadonlyMap<string, EffectHandler> = new Map<string, EffectHandler>([
  // BOMBARD — strike an enemy-held target body. DORMANT today: no provider grants a 'bombard'
  // verb yet (it rides an attacker's loadout with the mechanics), so nothing dispatches here —
  // the stub stands ready for when that provider lands. Will flip BodyOwnership and/or raze
  // facilities (all-or-nothing-now vs. partial body-damage is an open call — see the plan).
  ['bombard', (_intent) => { /* no-op stub: body-damage write-back lands with mechanics */ }],
]);
