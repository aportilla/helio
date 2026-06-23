// Immediate-action effect handlers — the app-side sink the live-view dispatch routes a
// confirmed 'immediate' ActionIntent into. SystemScene.onImmediate looks one up by
// actionId; a handler MUTATES the helio.game save (and later triggers the facility-edit
// reconcile chain so the diagram + economy re-read), which is exactly why these live
// app-side and NOT in the pure src/actions/ leaf.
//
// BONES: every handler is a well-commented NO-OP stub. M3 builds the ROUTING — confirm →
// dispatch by kind → handler keyed by actionId — not the mechanics. Each stub marks where
// its real world-mutation (and the reconcile that must follow it) will land. No mechanic is
// decided here.
//
// An 'immediate' action with no handler registered here (flee / pass — combat/decline verbs
// that resolve elsewhere or simply end a turn) falls through to SystemScene's DEV
// placeholder log; only the non-combat WORLD verbs register a handler.
//
// SEAM CONTRACT for the real handlers: intent.targetIds carry ENTITY ids, not raw save keys.
// A body target is entity-id-encoded ('body:<bodyIdx>') and a self-targeted body verb's
// target is the actor's own body id — so decode with parseEntityId(id) → bodyIdx →
// BODIES[bodyIdx].id before keying game-state (facilities/ownership) by raw Body.id, exactly
// as system-scene's slotCenterForEntity / pickForActorId already do. A ship target is the
// bare Ship.id.

import type { ActionIntent, ActionType } from '../../actions/types';

export type EffectHandler = (intent: ActionIntent) => void;

export const EFFECT_HANDLERS: ReadonlyMap<ActionType, EffectHandler> = new Map<ActionType, EffectHandler>([
  // MINE — work the acting body's OWN deposits (self-targeted; the target is the actor's own
  // bodyId). Will credit a one-shot yield (or flip a depleted-deposit overlay) on that body
  // via game-state, then run the facility-edit reconcile so the economy re-reads.
  ['mine', (_intent) => { /* no-op stub: mineral-yield write-back lands with mechanics */ }],
  // ESTABLISH — settle / develop the acting (colony) body itself (self-targeted). Will write
  // back to that body via game-state (facilities / development state), then reconcile.
  ['establish', (_intent) => { /* no-op stub: develop-body write-back lands with mechanics */ }],
  // BOMBARD — strike an enemy-held target body. Will flip its BodyOwnership and/or raze
  // facilities (all-or-nothing-now vs. partial body-damage is an open call — see the plan).
  ['bombard', (_intent) => { /* no-op stub: body-damage write-back lands with mechanics */ }],
]);
