// Shared test scaffolding: concise world builders and stepping helpers.

import { makeGeometry } from '../src/geometry.ts';
import { defaultResourceTable } from '../src/resources.ts';
import { defaultBalance } from '../src/constants.ts';
import type { BalanceConfig } from '../src/constants.ts';
import { makeWorld } from '../src/world.ts';
import type { PlanetSpec } from '../src/world.ts';
import { EconomyEngine } from '../src/engine.ts';
import type { EngineOptions } from '../src/engine.ts';
import type { WorldSkeleton } from '../src/serialize.ts';
import { asPlanet, asResource } from '../src/ids.ts';
import type { PlanetId, ResourceId } from '../src/ids.ts';

export const FOOD = asResource(0);
export const MINERALS = asResource(1);
export const MUNITIONS = asResource(2);
export const ENERGY = asResource(3);

export const P0 = asPlanet(0);
export const P1 = asPlanet(1);
export const P2 = asPlanet(2);
export const P3 = asPlanet(3);

/** Stars on the x-axis at the given coordinates (1-D line galaxy). */
export function lineGeometry(xs: readonly number[]) {
  return makeGeometry(xs.map((x) => [x, 0, 0] as const));
}

export interface SceneSpec {
  readonly xs: readonly number[]; // star positions on the x-axis
  readonly planets: readonly PlanetSpec[];
  readonly cfg?: Partial<BalanceConfig>;
  readonly seed?: number;
  readonly startTurn?: number;
  readonly engine?: EngineOptions;
}

export interface Scene {
  readonly engine: EconomyEngine;
  readonly skeleton: WorldSkeleton;
}

export function scene(spec: SceneSpec): Scene {
  const geometry = lineGeometry(spec.xs);
  const resources = defaultResourceTable();
  const cfg = defaultBalance(spec.cfg ?? {});
  const world = makeWorld({ geometry, resources, cfg, seed: spec.seed ?? 1, planets: spec.planets });
  if (spec.startTurn !== undefined) world.turn = spec.startTurn;
  const engine = new EconomyEngine(world, spec.engine ?? { checkInvariants: true });
  return { engine, skeleton: { geometry, resources, cfg } };
}

export function stepN(engine: EconomyEngine, n: number) {
  const reports = [];
  for (let i = 0; i < n; i++) reports.push(engine.step());
  return reports;
}

/** Convenience: a per-resource array with one resource set, rest 0. */
export function only(r: ResourceId, value: number, count = 4): number[] {
  const a = new Array<number>(count).fill(0);
  a[r as number] = value;
  return a;
}

export function coverOf(engine: EconomyEngine, p: PlanetId, r: ResourceId): number {
  return engine.getResourceCover(p, r);
}

export function stockOf(engine: EconomyEngine, p: PlanetId, r: ResourceId): number {
  return engine.world.stock[engine.world.pr(p, r as number)]!;
}
