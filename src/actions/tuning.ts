// Hoisted action accent colors — the menu-row hue each ActionGrant carries (grant.color), and a
// home for the timing / availability knobs the mechanics phase will add. Kept in one place so a
// palette pass never hunts through the grant authoring sites (the ship component + facility
// registries, which import these), and so docs reference them by NAME, never by value (a
// hex in prose rots the instant it's re-tuned). Re-tuning is non-breaking — the serialized action
// contract is the composed `"<providerId>:<grant.key>"` id (./derive), never these colors.
//
// PROVISIONAL: an early interpretation, distinct hues so a menu row reads at a glance. The fleet
// sprite tints by FACTION, never by these — the action color is reserved for the menu row / later
// pill (no consumer paints it yet).

// — Laser: a ship's beam weapon. A warm red-orange, hostile against the cyan/steel palette, in the
// offensive family with (but distinct from) the body railgun orange / missile amber. (small-laser)
export const LASER_ACTION_COLOR = '#e0644e';

// — Flee: evasive navigation. An amber distinct from the laser red and the cyan UI. Granted by the
// ship's engine (D9: every ship has a drive ⇒ every ship can flee). (small-engine)
export const FLEE_ACTION_COLOR = '#c9b46b';

// — Raise Shields: a ship's defensive SUPPORT verb. A protective blue, cooler than the cyan UI and
// distinct from the offensive reds/ambers — reads as a deflector going up. (small-shield)
export const SHIELD_ACTION_COLOR = '#5aa9d6';

// The body weapon / support verbs — each granted by a facility (see ../facilities/registry.ts).
// PROVISIONAL accents, each a distinct hue so a body actor's menu rows read at a glance, loosely
// echoing the facility palette they act on/with.

// — Bombard: strike an enemy-held body. A hostile crimson, hotter than the attack red. RESERVED:
// no facility grants bombard yet (it rides an attacker's loadout with the mechanics), so this
// accent is dormant until that provider lands.
export const BOMBARD_ACTION_COLOR = '#d23b3b';

// — Railgun: a body's kinetic weapon. A hot orange, the offensive family. (railgun-battery)
export const RAILGUN_ACTION_COLOR = '#ff7a4d';

// — Missile Launcher: a body's guided ordnance. An amber, distinct from the railgun orange.
// (missile-battery)
export const MISSILE_ACTION_COLOR = '#ffb24d';

// — Repair: mend a friendly ship. A heal green, distinct from the farm's food green. (shipyard)
export const REPAIR_ACTION_COLOR = '#6ad6a0';

// — Tactical Data: the sensor sweep. A recon teal, distinct from the colony cyan. (sensor-network)
export const TACTICAL_DATA_ACTION_COLOR = '#5ed8e0';
