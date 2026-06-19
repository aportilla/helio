// Resource metadata — the static, per-resource facts the kernel reads (§9).
//
// `enum` is unavailable (erasableSyntaxOnly, so Node can strip types with no
// codegen), so the discriminated sets are const objects + a derived union type.

/** Whether a resource moves at all (§9 / glossary §2). */
export const TransportTier = {
  /** Rides the one transfer mechanism. */
  Transportable: 0,
  /** Consumed where it's made (e.g. Energy) — never shipped. */
  LocalOnly: 1,
  /** A pooled abstract (e.g. research) — never shipped. */
  Intangible: 2,
} as const;
export type TransportTier = (typeof TransportTier)[keyof typeof TransportTier];

/** One resource's static profile. Criticality drives the matcher's score. All
 *  goods ship at the base milli granularity — there is no per-resource chunk. */
export interface ResourceMeta {
  readonly id: number;
  readonly name: string;
  readonly tier: TransportTier;
  /** Higher = more vital; the dominant term in a demand's allocation score (§5). */
  readonly criticality: number;
}

/** The full resource table: dense, id-indexed, sorted-key iterable. */
export interface ResourceTable {
  readonly metas: readonly ResourceMeta[];
  readonly count: number;
}

export function makeResourceTable(metas: readonly ResourceMeta[]): ResourceTable {
  metas.forEach((m, i) => {
    if (m.id !== i) throw new Error(`ResourceTable: meta[${i}] has id ${m.id} (must equal index)`);
  });
  return { metas, count: metas.length };
}

/** A small default table used by tests and the standalone harness. Two staples
 *  (vital), one strategic (high criticality), one LocalOnly (Energy — never
 *  shipped) to exercise the tier filter. */
export function defaultResourceTable(): ResourceTable {
  return makeResourceTable([
    { id: 0, name: 'Food', tier: TransportTier.Transportable, criticality: 100 },
    { id: 1, name: 'Minerals', tier: TransportTier.Transportable, criticality: 60 },
    { id: 2, name: 'Munitions', tier: TransportTier.Transportable, criticality: 80 },
    { id: 3, name: 'Energy', tier: TransportTier.LocalOnly, criticality: 90 },
  ]);
}
