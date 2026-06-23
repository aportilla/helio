// deriveCommands + the command-id codec — the derive-and-merge heart of the inverted action
// model. Runs under `node --test` (type-stripping): the ActionGrant import is erased, so this
// loads only the node-pure derive leaf — no registry, no DOM, no sim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveCommands, grantKeyOf, commandFor, type GrantProvider } from '../derive.ts';
import type { Actor, ActionGrant } from '../types.ts';

const grant = (over: Partial<ActionGrant> & Pick<ActionGrant, 'key'>): ActionGrant => ({
  label: over.key,
  color: '#ffffff',
  category: 'attack',
  targeting: 'single',
  kind: 'immediate',
  ...over,
});

test('a single provider grant becomes one command with a composed id', () => {
  const cmds = deriveCommands([{ id: 'railgun-battery', grants: [grant({ key: 'railgun', label: 'Railgun' })] }]);
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0]!.id, 'railgun-battery:railgun');
  assert.equal(cmds[0]!.grant.label, 'Railgun');
  assert.equal(cmds[0]!.count, 1);
  assert.equal(cmds[0]!.totalCost, 0, 'absent costPerUnit ⇒ 0 (no energy model yet)');
});

test('identical providers merge into ONE scaled command (D2)', () => {
  const missile = grant({ key: 'missile', label: 'Missile' });
  const cmds = deriveCommands([
    { id: 'missile-battery', grants: [missile] },
    { id: 'missile-battery', grants: [missile] },
    { id: 'missile-battery', grants: [missile] },
  ]);
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0]!.count, 3, 'three identical providers stack');
  assert.equal(cmds[0]!.id, 'missile-battery:missile');
});

test('heterogeneous grants stay separate, in first-seen order', () => {
  const cmds = deriveCommands([
    { id: 'missile-battery', grants: [grant({ key: 'missile', label: 'Missile' })] },
    { id: 'railgun-battery', grants: [grant({ key: 'railgun', label: 'Railgun' })] },
    { id: 'drive', grants: [grant({ key: 'flee', label: 'Flee', category: 'navigation', targeting: 'self' })] },
  ]);
  assert.deepEqual(cmds.map((c) => c.id), ['missile-battery:missile', 'railgun-battery:railgun', 'drive:flee']);
  assert.deepEqual(cmds.map((c) => c.count), [1, 1, 1]);
});

test('two providers SHARING a key stay separate — the merge key is the composed id, not the bare key', () => {
  // Weapons key by capability so a shared key is rare in real loadouts, but the projection must
  // still separate by provider: a regression to bare-key merging would wrongly stack distinct
  // providers into one command.
  const cmds = deriveCommands([
    { id: 'turret-a', grants: [grant({ key: 'beam', label: 'Beam A' })] },
    { id: 'turret-b', grants: [grant({ key: 'beam', label: 'Beam B' })] },
  ]);
  assert.deepEqual(cmds.map((c) => c.id), ['turret-a:beam', 'turret-b:beam']);
  assert.deepEqual(cmds.map((c) => c.count), [1, 1]);
});

test('totalCost is linear: count × costPerUnit (D7)', () => {
  const missile = grant({ key: 'missile', costPerUnit: 3 });
  const cmds = deriveCommands([
    { id: 'missile-battery', grants: [missile] },
    { id: 'missile-battery', grants: [missile] },
  ]);
  assert.equal(cmds[0]!.count, 2);
  assert.equal(cmds[0]!.totalCost, 6, '2 × 3');
});

test('a provider with no grants (a chassis / pure-economy facility) contributes nothing', () => {
  assert.deepEqual(deriveCommands([{ id: 'chassis' }, { id: 'farm', grants: [] }]), []);
  assert.deepEqual(deriveCommands([]), []);
});

test('a multi-grant provider yields one command per grant', () => {
  const providers: readonly GrantProvider[] = [
    { id: 'deck', grants: [grant({ key: 'recon', category: 'support', targeting: 'self' }), grant({ key: 'command', category: 'support', targeting: 'self' })] },
  ];
  assert.deepEqual(deriveCommands(providers).map((c) => c.id), ['deck:recon', 'deck:command']);
});

test('grantKeyOf extracts the capability identity; a bare id (pass) maps to itself; splits on the LAST colon', () => {
  assert.equal(grantKeyOf('mining-base:mine'), 'mine');
  assert.equal(grantKeyOf('railgun-battery:railgun'), 'railgun');
  assert.equal(grantKeyOf('pass'), 'pass');
  // A future namespaced provider id ('turret:dorsal') keeps the key intact via last-colon split.
  assert.equal(grantKeyOf('turret:dorsal:railgun'), 'railgun');
});

test('commandFor resolves the command behind an intent; Pass / unknown ⇒ undefined (the dispatch fork)', () => {
  // This is the pure helper the SCENE dispatch (system-action-menu) reads `.grant.kind` off to
  // fork immediate vs encounter — pinned here so the fork is covered without a DOM.
  const actor: Actor = {
    id: 'a1',
    commands: deriveCommands([
      { id: 'missile-battery', grants: [grant({ key: 'missile', label: 'Missile Launcher', kind: 'encounter' })] },
      { id: 'mining-base', grants: [grant({ key: 'mine', category: 'support', targeting: 'self' })] }, // helper defaults kind 'immediate'
    ]),
  };
  assert.equal(commandFor(actor, 'missile-battery:missile')?.grant.kind, 'encounter', 'an encounter command ⇒ onEnterEncounter');
  assert.equal(commandFor(actor, 'mining-base:mine')?.grant.kind, 'immediate', 'an immediate command ⇒ onImmediate');
  assert.equal(commandFor(actor, 'pass'), undefined, 'menu-injected Pass is not a command ⇒ immediate path');
  assert.equal(commandFor(actor, 'nope:nope'), undefined, 'an unknown id ⇒ immediate path');
});
