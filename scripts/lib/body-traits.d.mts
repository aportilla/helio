// Type surface for body-traits.mjs. The predicate library lives in plain JS so
// the Node audits can import it with no TS toolchain; this declaration lets the
// browser bundle (the body label) and dump-labels.mjs consume the predicates
// under strict typing. Mirrors the prng.mjs / gas-potency.mjs cross-boundary
// pattern.

import type { Body } from '../../src/data/stars';

// The single source of the radius brackets + classification gates. procgen reads
// `gasDwarfRadius` from it.
export const BODY_THRESHOLDS: Record<string, number>;

// Bracket membership.
export function isGaseousBody(b: Body): boolean;
export function isClassifiable(b: Body): boolean;

// Gaseous family.
export function isVeiledIce(b: Body): boolean;
export function isHelium(b: Body): boolean;
export function isGasGiant(b: Body): boolean;
export function isHotGiant(b: Body): boolean;
export function isIceGiant(b: Body): boolean;
export function isSubNeptune(b: Body): boolean;

// Surface / subsurface-liquid family.
export function isBrimstone(b: Body): boolean;
export function isTholin(b: Body): boolean;
export function isGaian(b: Body): boolean;
export function isAmmoniaSea(b: Body): boolean;
export function isSubglacialOcean(b: Body): boolean;
export function isOcean(b: Body): boolean;

// Base terrestrial family.
export function isChthonian(b: Body): boolean;
export function isLava(b: Body): boolean;
export function isMagmaOcean(b: Body): boolean;
export function isVolcanic(b: Body): boolean;
export function isIron(b: Body): boolean;
export function isFrostbound(b: Body): boolean;
export function isGlacial(b: Body): boolean;
export function isSuperEarth(b: Body): boolean;
export function isDesert(b: Body): boolean;
