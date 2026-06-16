// abundanceMilli — a body's "site richness" for one economic resource, as an
// integer-milli scalar in roughly [0, RICHNESS_MILLI_PER_UNIT]. This is what
// SCALES a facility's production; it is not itself a resource or a stock (plan
// §8). The catalog's six 0..10 abundance indices and six 0..1 biotic scalars are
// mapped here. Every float→int crossing in the seam is an explicit Math.floor in
// THIS file (indexToMilli, rareTechMilli, foodMilli, scaleByRichness) — so every
// value out of it is integer milli and nothing downstream is float.

import type { Body } from '../data/stars.ts';
import { EconResource } from './resource-vocab.ts';
import { RARE_RADIO_WEIGHT_MILLI, RICHNESS_MILLI_PER_UNIT } from './tuning.ts';

// 0..10 catalog index → milli. Null indices (some belts/rings) clamp to 0, the
// stated null policy; out-of-range inputs are clamped defensively.
function indexToMilli(idx: number | null): number {
  if (idx === null) return 0;
  const clamped = Math.max(0, Math.min(10, idx));
  return Math.floor((clamped / 10) * RICHNESS_MILLI_PER_UNIT);
}

// RareTech draws on rare earths plus a weighted slice of radioactives. The
// weight is a fixed-point fraction of RICHNESS_MILLI_PER_UNIT, so this stays
// integer-only and can exceed one richness unit on a rare-AND-radioactive world.
function rareTechMilli(body: Body): number {
  const rare = indexToMilli(body.resRareEarths);
  const radio = indexToMilli(body.resRadioactives);
  return rare + Math.floor((radio * RARE_RADIO_WEIGHT_MILLI) / RICHNESS_MILLI_PER_UNIT);
}

// Food richness = the body's strongest biotic productivity across all six
// archetypes (a body can score on several at once). The scalars are already
// 0..1, so they scale straight to the richness unit; null archetypes are 0.
function foodMilli(body: Body): number {
  const biotic = Math.max(
    body.bioticCarbonAqueous ?? 0,
    body.bioticSubsurfaceAqueous ?? 0,
    body.bioticAerial ?? 0,
    body.bioticCryogenic ?? 0,
    body.bioticSilicate ?? 0,
    body.bioticSulfur ?? 0,
  );
  return Math.floor(Math.max(0, Math.min(1, biotic)) * RICHNESS_MILLI_PER_UNIT);
}

export function abundanceMilli(body: Body, res: EconResource): number {
  switch (res) {
    case EconResource.Alloys: return indexToMilli(body.resMetals);
    case EconResource.Minerals: return indexToMilli(body.resSilicates);
    case EconResource.Volatiles: return indexToMilli(body.resVolatiles);
    case EconResource.Exotics: return indexToMilli(body.resExotics);
    case EconResource.RareTech: return rareTechMilli(body);
    case EconResource.Food: return foodMilli(body);
    // Energy has no catalog source — it is facility-flat (plan §8).
    case EconResource.Energy: return 0;
    default: return 0;
  }
}

// Apply richness to a per-turn base rate: output = base · richness / unit. With
// richness === RICHNESS_MILLI_PER_UNIT (full site), output === base; richness 0
// yields 0. Floored once, integer in and out.
export function scaleByRichness(baseMilli: number, richnessMilli: number): number {
  return Math.floor((baseMilli * richnessMilli) / RICHNESS_MILLI_PER_UNIT);
}
